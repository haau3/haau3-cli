// `haau3 login`: a person approves this computer in the browser, and the command line keeps a short
// session (RFC 8628's device authorization grant). It never leaves an agent waiting: with no
// terminal it prints the page, the code, when the code expires and the next command, then exits, and
// `haau3 login --complete` waits for the approval, for at most COMPLETE_WAIT_MS a run. A person at a
// terminal gets one command that waits.
//
// It prints the page to open and the code to type, never the page with the code filled in, which RFC
// 8628 (section 5.4) says makes remote phishing easier. The device code stays in the session store.
import { resolvePlatform } from "../environment.js";
import type { CliError } from "../output.js";
import { discover } from "../signin/discovery.js";
import { revoke, startSignIn, waitForApproval, type PendingSignIn, type WaitOutcome } from "../signin/device.js";
import { readWhoami } from "../signin/whoami.js";
import type { Session, SessionRecord } from "../session/record.js";
import type { Where } from "../session/store.js";
import {
  COMPLETE_STEP,
  done,
  failed,
  LOGIN_STEP,
  LOGOUT_STEP,
  misused,
  nextText,
  storeData,
  storeFailed,
  storeSentence,
  when,
  WHOAMI_STEP,
  type Context,
  type Result,
} from "./context.js";

/** How long one `login --complete` waits: inside the two minutes an agent's tool call is commonly given. */
export const COMPLETE_WAIT_MS = 100_000;

/** A waiting code with less than this left is not offered again: nobody could type it in time. */
const MIN_CODE_LEFT_MS = 60_000;

/** The platform takes a session for at most an hour from the token's issue. */
const SESSION_MS = 60 * 60_000;

/** The step that follows signing in. `keys create` takes its place once that command exists. */
const AFTER_SIGN_IN = [WHOAMI_STEP];

export async function login(ctx: Context, options: { complete: boolean }): Promise<Result> {
  const platform = resolvePlatform(ctx.env);
  if (!platform.ok) return misused("login", platform.error);
  const address = platform.platformURL;
  const { record, where } = await ctx.store.load(address);
  const now = ctx.now();

  if (options.complete) return complete(ctx, address, record, where);

  if (record.session && record.session.expiresAt > now) return alreadySignedIn(ctx, record.session, where);
  if (record.session) {
    // Its hour is over: end the grant behind it, as every session's end does, and start again.
    await endSession(record.session);
    delete record.session;
    await ctx.store.save(address, record);
  }

  let pending = record.pending && record.pending.expiresAt - now >= MIN_CODE_LEFT_MS ? record.pending : undefined;
  if (!pending) {
    const found = await discover(address);
    if (!found.ok) return failed("login", found.error);
    const started = await startSignIn(found.service, now);
    if (!started.ok) return failed("login", started.error);
    pending = started.pending;
    const kept = await ctx.store.save(address, { pending });
    if (!kept) return failed("login", storeFailed(ctx.store.filePath));
  }

  if (!ctx.interactive) {
    const data = {
      status: "approval-needed",
      verificationUri: pending.verificationUri,
      userCode: pending.userCode,
      expiresAt: new Date(pending.expiresAt).toISOString(),
      next: [COMPLETE_STEP],
    };
    return done("login", data, `${approvalText(pending, now)}${nextText([COMPLETE_STEP])}`);
  }

  ctx.say(`${approvalText(pending, now)}\n${ctx.openBrowser ? "Press Enter to open the page in your browser.\n" : ""}Waiting for your approval...\n`);
  const listening = ctx.openBrowser ? ctx.enter?.() : undefined;
  const page = pending.verificationUri;
  void listening?.pressed.then(() => {
    if (!ctx.openBrowser?.(page)) ctx.say("The browser could not be opened. Open the page yourself.\n");
  });
  try {
    const outcome = await waitForApproval(pending, pending.expiresAt, ctx, (p) => keepPending(ctx, address, p));
    return await finish(ctx, address, pending, outcome);
  } finally {
    listening?.stop();
  }
}

async function complete(ctx: Context, address: string, record: SessionRecord, where: Where | null): Promise<Result> {
  const now = ctx.now();
  const pending = record.pending;
  if (!pending) {
    // Run again after it worked: the answer an agent retrying needs is that it is signed in.
    if (record.session && record.session.expiresAt > now) return alreadySignedIn(ctx, record.session, where);
    return failed("login", {
      code: "no-sign-in-pending",
      message: "No sign-in is waiting for approval here. If the first step ran in a sandbox, run this one in the same sandbox.",
      next: [LOGIN_STEP],
    });
  }
  if (pending.expiresAt <= now) {
    await ctx.store.save(address, { session: record.session });
    return failed("login", codeExpired());
  }
  const outcome = await waitForApproval(pending, now + COMPLETE_WAIT_MS, ctx, (p) => keepPending(ctx, address, p));
  return finish(ctx, address, pending, outcome);
}

async function finish(ctx: Context, address: string, pending: PendingSignIn, outcome: WaitOutcome): Promise<Result> {
  if (outcome.kind === "still-pending") {
    return failed("login", {
      code: "approval-pending",
      message: `The sign-in is still waiting for approval. Open ${pending.verificationUri} and enter the code ${pending.userCode} before ${when(pending.expiresAt, ctx.now())}.`,
      next: [COMPLETE_STEP],
    });
  }
  // Whatever happened next, this code is spent.
  await ctx.store.save(address, {});
  if (outcome.kind === "expired") return failed("login", codeExpired());
  if (outcome.kind === "denied") {
    return failed("login", { code: "approval-denied", message: "The sign-in was refused on the approval page.", next: [LOGIN_STEP] });
  }
  if (outcome.kind === "failed") {
    const why = outcome.reason ? ` (${outcome.reason})` : "";
    return failed("login", { code: "sign-in-failed", message: `The sign-in service did not finish the sign-in${why}.`, next: [LOGIN_STEP] });
  }

  const token = outcome.token;
  // The token was issued moments ago, so an hour from now is never earlier than the platform's end.
  const latestEnd = ctx.now() + SESSION_MS;
  const service = pending.service;
  const who = await readWhoami(address, token);
  if (who.kind !== "ok") {
    // The platform will not take this token, or cannot say whose it is: end the grant rather than keep it.
    await revoke(token, service.revocationEndpoint, service.clientId);
    return failed("login", whoamiRefusal(who));
  }
  const session: Session = {
    accessToken: token,
    // The platform's own end, or an hour from now if that were sooner: never later than the platform's.
    expiresAt: Math.min(latestEnd, Date.parse(who.whoami.session.expiresAt)),
    issuer: service.issuer,
    clientId: service.clientId,
    revocationEndpoint: service.revocationEndpoint,
    member: who.whoami.member,
    organization: who.whoami.organization,
  };
  const kept = await ctx.store.save(address, { session });
  if (!kept) {
    await revoke(token, service.revocationEndpoint, service.clientId);
    return failed("login", storeFailed(ctx.store.filePath));
  }
  const now = ctx.now();
  const data = {
    status: "signed-in",
    member: session.member,
    organization: session.organization,
    session: { expiresAt: new Date(session.expiresAt).toISOString(), ...storeData(kept) },
    next: AFTER_SIGN_IN,
  };
  const text = [
    `Signed in as ${memberName(session)} in ${session.organization.name}.`,
    `The session ends at ${when(session.expiresAt, now)}.`,
    storeSentence(kept),
  ].join("\n");
  return done("login", data, `${text}\n${nextText(AFTER_SIGN_IN)}`);
}

function alreadySignedIn(ctx: Context, session: Session, where: Where | null): Result {
  const steps = [WHOAMI_STEP, LOGOUT_STEP];
  const data = {
    status: "already-signed-in",
    member: session.member,
    organization: session.organization,
    session: { expiresAt: new Date(session.expiresAt).toISOString(), ...(where ? storeData(where) : { store: null, storeName: null, storePath: null }) },
    next: steps,
  };
  const text = [
    `Already signed in as ${memberName(session)} in ${session.organization.name}.`,
    `The session ends at ${when(session.expiresAt, ctx.now())}.`,
  ].join("\n");
  return done("login", data, `${text}\n${nextText(steps)}`);
}

export function approvalText(pending: PendingSignIn, now: number): string {
  return [
    "To sign in, open this page and enter the code.",
    "",
    `  Page: ${pending.verificationUri}`,
    `  Code: ${pending.userCode}`,
    `  The code expires at ${when(pending.expiresAt, now)}.`,
    "",
  ].join("\n");
}

export function memberName(session: Pick<Session, "member">): string {
  return session.member.email ?? session.member.id;
}

/** Ends the grant a session's token belongs to. True when the sign-in service said it did. */
export function endSession(session: Session): Promise<boolean> {
  return revoke(session.accessToken, session.revocationEndpoint, session.clientId);
}

async function keepPending(ctx: Context, address: string, pending: PendingSignIn): Promise<void> {
  await ctx.store.save(address, { pending });
}

function codeExpired(): CliError {
  return { code: "code-expired", message: "The code expired before it was approved.", next: [LOGIN_STEP] };
}

function whoamiRefusal(who: Exclude<Awaited<ReturnType<typeof readWhoami>>, { kind: "ok" }>): CliError {
  if (who.kind === "error") return { ...who.error, next: [LOGIN_STEP] };
  if (who.kind === "ended") {
    return { code: "sign-in-refused", message: "The platform did not accept the sign-in.", next: [LOGIN_STEP], problem: who.problem };
  }
  return organizationError(who.code, who.problem);
}

/** The platform's 403s, in a person's words. */
export function organizationError(code: "not-a-member" | "no-organization", problem: CliError["problem"], organization?: string): CliError {
  const message =
    code === "not-a-member"
      ? `You are not a member of ${organization ?? "the organization picked on the approval page"}. Sign in again and pick an organization you belong to.`
      : "No organization was picked on the approval page. Sign in again and pick one.";
  return { code, message, next: [LOGIN_STEP], problem };
}
