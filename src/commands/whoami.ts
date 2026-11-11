// `haau3 whoami`: who is signed in, in which organization, on which plan, this month's use and when
// the session ends, as the platform says it now. A session the platform no longer takes is ended
// here: its grant revoked and its copy deleted, so nothing on the computer keeps a dead token.
import { resolvePlatform } from "../environment.js";
import { readWhoami } from "../signin/whoami.js";
import { COMPLETE_STEP, done, failed, LOGIN_STEP, misused, storeData, storeSentence, when, type Context, type Result } from "./context.js";
import { memberName, organizationError } from "./login.js";
import { endOnThisClock, endSession, loadRecord } from "./session.js";

export async function whoami(ctx: Context): Promise<Result> {
  const platform = resolvePlatform(ctx.env);
  if (!platform.ok) return misused("whoami", platform.error);
  const address = platform.platformURL;
  const { record, where, keyringUnreachable } = await loadRecord(ctx, address);
  const session = record.session;

  if (!session) {
    if (record.pending && record.pending.expiresAt > ctx.now()) {
      return failed("whoami", { code: "not-signed-in", message: "Not signed in yet: a sign-in is waiting for approval.", next: [COMPLETE_STEP] });
    }
    // Said so when it cannot be told: a sandbox that blocks the credential store hides a session kept there.
    const unseen = keyringUnreachable ? " The system's credential store could not be reached, so a session kept there could not be checked." : "";
    return failed("whoami", { code: "not-signed-in", message: `Not signed in.${unseen}`, next: [LOGIN_STEP] });
  }

  if (session.expiresAt <= ctx.now()) {
    await endSession(session);
    await ctx.store.save(address, { pending: record.pending });
    return failed("whoami", { code: "session-ended", message: `The session ended at ${when(session.expiresAt, ctx.now())}. Sign in again.`, next: [LOGIN_STEP] });
  }

  const who = await readWhoami(address, session.accessToken);
  if (who.kind === "error") return failed("whoami", who.error);
  if (who.kind !== "ok") {
    await endSession(session);
    await ctx.store.save(address, { pending: record.pending });
    if (who.kind === "ended") {
      return failed("whoami", { code: "session-ended", message: "The session has ended. Sign in again.", next: [LOGIN_STEP], problem: who.problem });
    }
    return failed("whoami", organizationError(who.code, who.problem, session.organization.name));
  }

  const { member, organization, role, plan, usage } = who.whoami;
  const now = ctx.now();
  const expiresAt = Math.min(session.expiresAt, endOnThisClock(who.whoami.session.expiresAt, who.platformNow, now));
  const kept = where ?? { kind: "file" as const, name: "a file only you can read", path: ctx.store.filePath, reason: null };
  const data = {
    member,
    organization,
    role,
    plan,
    usage,
    session: { expiresAt: new Date(expiresAt).toISOString(), ...storeData(kept) },
  };
  const text = [
    `${memberName({ member })}, ${role.replace(/^org:/, "")} in ${organization.name}${organization.slug ? ` (${organization.slug})` : ""}`,
    `Plan: ${plan.name}. ${usage ? `${usage.headline}.` : "This month's use could not be read."}`,
    `The session ends at ${when(expiresAt, now)}.`,
    storeSentence(kept),
  ].join("\n");
  return done("whoami", data, `${text}\n`);
}
