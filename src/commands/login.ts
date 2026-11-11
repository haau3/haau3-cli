// `haau3 login`: a person approves this computer in the browser, and the command line keeps a short
// session (RFC 8628's device authorization grant). It never leaves an agent waiting: with no
// terminal it prints the page, the code, when the code expires and the next command, then exits, and
// `haau3 login --complete` waits for the approval, the whole run inside COMPLETE_WAIT_MS. A person at
// a terminal gets one command that waits.
//
// It prints the page to open and the code to type, never the page with the code filled in, which RFC
// 8628 (section 5.4) says makes remote phishing easier. The device code stays in the session store.
//
// Several runs can wait on one code (a person at a terminal and their agent, or an agent running
// --complete again), so every write reads the store first and changes only what is this run's: a
// run that loses the race leaves the winner's session alone.
import { DEFAULT_PLATFORM_URL, resolvePlatform } from "../environment.js";
import type { CliError } from "../output.js";
import { discover, sameService } from "../signin/discovery.js";
import { revoke, startSignIn, waitForApproval, type PendingSignIn, type WaitOutcome } from "../signin/device.js";
import { readWhoami } from "../signin/whoami.js";
import type { Session } from "../session/record.js";
import type { Where } from "../session/store.js";
import {
  COMPLETE_STEP,
  done,
  failed,
  KEYS_CREATE_STEP,
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
import { endOnThisClock, endSession, loadRecord, REVOKE_TIMEOUT_MS, sameCode, type Current } from "./session.js";

/**
 * The most one `login --complete` takes, from start to answer: inside the two minutes an agent's tool
 * call is commonly given. The polls stop early enough to leave room for what follows an approval.
 */
export const COMPLETE_WAIT_MS = 100_000;

/** How long reading who signed in may take once the token is in hand. */
const WHOAMI_TIMEOUT_MS = 15_000;

/** What follows an approval inside a run's limit: whoami, then a revocation if the platform refuses. */
const AFTER_APPROVAL_MS = WHOAMI_TIMEOUT_MS + REVOKE_TIMEOUT_MS;

/** A waiting code with less than this left is not offered again: nobody could type it in time. */
const MIN_CODE_LEFT_MS = 60_000;

/** The platform takes a session for at most an hour from the token's issue. */
const SESSION_MS = 60 * 60_000;

/** The step that follows signing in: a key for the project. */
const AFTER_SIGN_IN = [KEYS_CREATE_STEP];

export async function login(ctx: Context, options: { complete: boolean }): Promise<Result> {
  const platform = resolvePlatform(ctx.env);
  if (!platform.ok) return misused("login", platform.error);
  const address = platform.platformURL;
  const current = await loadRecord(ctx, address);
  const { record } = current;
  const now = ctx.now();

  if (options.complete) return complete(ctx, address, current);

  if (record.session && record.session.expiresAt > now) return alreadySignedIn(ctx, record.session, current.where);
  if (record.session) {
    // Its hour is over: end the grant behind it, as every session's end does, and start again.
    await endSession(record.session);
    delete record.session;
    await ctx.store.save(address, record);
  }

  // Where to sign in is asked every time, and a waiting code is offered again only when it was made
  // with the sign-in service the platform names now: a code nobody here asked for is never shown.
  const found = await discover(address);
  if (!found.ok) return failed("login", found.error);
  let pending = record.pending;
  if (!pending || pending.expiresAt - now < MIN_CODE_LEFT_MS || !sameService(pending.service, found.service)) {
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
      platform: address,
      signInService: pending.service.issuer,
      next: [COMPLETE_STEP],
    };
    return done("login", data, `${approvalText(pending, now)}${nextText([COMPLETE_STEP])}`);
  }

  ctx.say(`${approvalText(pending, now)}\n${ctx.openBrowser ? "Press Enter to open the page in your browser.\n" : ""}Waiting for your approval...\n`);
  const listening = ctx.openBrowser ? ctx.enter?.() : undefined;
  const page = pending.verificationUri;
  void listening?.pressed.then(async () => {
    if (!(await ctx.openBrowser?.(page))) ctx.say("The browser could not be opened. Open the page yourself.\n");
  });
  try {
    const outcome = await waitForApproval(pending, Number.POSITIVE_INFINITY, ctx, (p) => keepInterval(ctx, address, p));
    return await finish(ctx, address, pending, outcome);
  } finally {
    listening?.stop();
  }
}

async function complete(ctx: Context, address: string, current: Current): Promise<Result> {
  const start = ctx.now();
  const { record } = current;
  const pending = record.pending;
  if (!pending) {
    // Run again after it worked: the answer an agent retrying needs is that it is signed in.
    if (record.session && record.session.expiresAt > start) return alreadySignedIn(ctx, record.session, current.where);
    if (record.session) {
      await endSession(record.session);
      await ctx.store.save(address, {});
    }
    return failed("login", {
      code: "no-sign-in-pending",
      message: "No sign-in is waiting for approval here. If the first step ran in a sandbox, run this one in the same sandbox.",
      next: [LOGIN_STEP],
    });
  }
  if (pending.expiresAt <= start) {
    await dropCode(ctx, address, pending);
    return failed("login", codeExpired());
  }
  const pollsEnd = start + COMPLETE_WAIT_MS - AFTER_APPROVAL_MS;
  const outcome = await waitForApproval(pending, pollsEnd, ctx, (p) => keepInterval(ctx, address, p));
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
  if (outcome.kind !== "approved") {
    // This code is spent. Another run may have signed in with it, in which case that is the answer.
    const winner = await dropCode(ctx, address, pending);
    if (winner) return alreadySignedIn(ctx, winner.session, winner.where);
    if (outcome.kind === "expired") return failed("login", codeExpired());
    if (outcome.kind === "denied") return failed("login", { code: "approval-denied", message: "The sign-in was refused on the approval page.", next: [LOGIN_STEP] });
    const why = outcome.reason ? ` (${outcome.reason})` : "";
    // A code spent by another run that is still finishing: that run's session is the answer, shortly.
    if (outcome.reason === "invalid_grant") {
      return failed("login", {
        code: "sign-in-failed",
        message: `The sign-in service did not finish the sign-in${why}. If another haau3 login used this code, it is signing you in.`,
        next: [WHOAMI_STEP, LOGIN_STEP],
      });
    }
    return failed("login", { code: "sign-in-failed", message: `The sign-in service did not finish the sign-in${why}.`, next: [LOGIN_STEP] });
  }

  const token = outcome.token;
  const service = pending.service;
  const refuse = async (error: CliError) => {
    // The platform will not take this token, or cannot say whose it is: end the grant rather than keep it.
    await revoke(token, service.revocationEndpoint, service.clientId, REVOKE_TIMEOUT_MS);
    await dropCode(ctx, address, pending);
    return failed("login", error);
  };
  const who = await readWhoami(address, token, WHOAMI_TIMEOUT_MS);
  if (who.kind !== "ok") return refuse(whoamiRefusal(who));

  const now = ctx.now();
  const ends = [now + SESSION_MS, endOnThisClock(who.whoami.session.expiresAt, who.platformNow, now)];
  if (outcome.expiresIn) ends.push(now + outcome.expiresIn * 1000);
  const expiresAt = Math.min(...ends);
  if (expiresAt <= now) return refuse({ code: "sign-in-refused", message: "The platform says this sign-in has already ended.", next: [LOGIN_STEP] });

  const session: Session = {
    accessToken: token,
    expiresAt,
    issuer: service.issuer,
    clientId: service.clientId,
    revocationEndpoint: service.revocationEndpoint,
    member: who.whoami.member,
    organization: who.whoami.organization,
  };
  // A session another run kept meanwhile is replaced by this newer one, its grant ended first.
  const latest = await loadRecord(ctx, address);
  if (latest.record.session && latest.record.session.accessToken.reveal() !== token.reveal()) await endSession(latest.record.session);
  const kept = await ctx.store.save(address, { session });
  if (!kept) return refuse(storeFailed(ctx.store.filePath));

  const data = {
    status: "signed-in",
    member: session.member,
    organization: session.organization,
    platform: address,
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
  const steps = [KEYS_CREATE_STEP, WHOAMI_STEP, LOGOUT_STEP];
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

/** What a person reads to approve: where they are signing in when it is not haau3's own platform, the page and the code. */
export function approvalText(pending: PendingSignIn, now: number): string {
  const lines: string[] = [];
  if (pending.service.platformURL !== DEFAULT_PLATFORM_URL) {
    lines.push(`Signing in to ${new URL(pending.service.platformURL).host} through ${new URL(pending.service.issuer).host}, as HAAU3_PLATFORM_URL asks.`, "");
  }
  lines.push(
    "To sign in, open this page and enter the code.",
    "",
    `  Page: ${pending.verificationUri}`,
    `  Code: ${pending.userCode}`,
    `  The code expires at ${when(pending.expiresAt, now)}.`,
    "",
  );
  return lines.join("\n");
}

export function memberName(session: Pick<Session, "member">): string {
  return session.member.email ?? session.member.id;
}

/** Keeps a raised interval for the next run, only while the stored code is still this one. */
async function keepInterval(ctx: Context, address: string, pending: PendingSignIn): Promise<void> {
  const latest = await ctx.store.load(address);
  if (!sameCode(latest.record.pending, pending)) return;
  latest.record.pending!.interval = pending.interval;
  await ctx.store.save(address, latest.record);
}

/**
 * Forgets this run's code, and nothing else: another run's session, or another code, is left as it is.
 * Returns a session another run kept, when there is a good one, which is then this run's answer.
 */
async function dropCode(ctx: Context, address: string, pending: PendingSignIn): Promise<{ session: Session; where: Where | null } | null> {
  const latest = await loadRecord(ctx, address);
  if (sameCode(latest.record.pending, pending)) {
    delete latest.record.pending;
    await ctx.store.save(address, latest.record);
  }
  const session = latest.record.session;
  return session && session.expiresAt > ctx.now() ? { session, where: latest.where } : null;
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
