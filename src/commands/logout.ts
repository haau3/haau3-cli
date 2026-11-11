// `haau3 logout`: ends the session. It revokes the access token, which ends the whole grant behind it,
// then deletes the session from both stores, along with any sign-in still waiting for approval.
// Signed out already is not a failure, so an agent or a script can always run it.
import { resolvePlatform } from "../environment.js";
import { done, failed, misused, when, type Context, type Result } from "./context.js";
import { endSession } from "./login.js";

export async function logout(ctx: Context): Promise<Result> {
  const platform = resolvePlatform(ctx.env);
  if (!platform.ok) return misused("logout", platform.error);
  const address = platform.platformURL;
  const { record } = await ctx.store.load(address);
  const pendingCleared = Boolean(record.pending);

  if (!record.session) {
    if (pendingCleared) await ctx.store.clear(address);
    const text = pendingCleared ? "Already signed out. The sign-in that was waiting for approval is cancelled.\n" : "Already signed out.\n";
    return done("logout", { status: "already-signed-out", revoked: false, pendingCleared }, text);
  }

  const session = record.session;
  const revoked = await endSession(session);
  await ctx.store.clear(address);
  if (!revoked) {
    const host = new URL(address).host;
    const now = ctx.now();
    const after =
      session.expiresAt > now
        ? `${host} stops taking it at ${when(session.expiresAt, now)}.`
        : `${host} already stopped taking it.`;
    return failed("logout", {
      code: "revoke-failed",
      message: `Signed out on this computer, but the sign-in service could not be reached to end the approval. ${after}`,
      next: [],
    });
  }
  return done("logout", { status: "signed-out", revoked: true, pendingCleared }, "Signed out. The approval has ended too.\n");
}
