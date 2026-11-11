// `haau3 logout`: ends the session. It revokes the access token, which ends the whole grant behind it,
// then deletes the session from both stores, along with any sign-in still waiting for approval.
// Signed out already is not a failure, so an agent or a script can always run it; but it says signed
// out only when it could look everywhere a session could be.
import { resolvePlatform } from "../environment.js";
import type { CliError } from "../output.js";
import { done, failed, misused, when, type Context, type Result } from "./context.js";
import { endSession, loadRecord } from "./session.js";

const UNREACHABLE =
  "The system's credential store could not be reached, so a session kept there could not be checked or ended. Run haau3 logout again where it can be reached, such as outside a sandbox.";

export async function logout(ctx: Context): Promise<Result> {
  const platform = resolvePlatform(ctx.env);
  if (!platform.ok) return misused("logout", platform.error);
  const address = platform.platformURL;
  const { record, keyringUnreachable, fileOnly } = await loadRecord(ctx, address);
  const pendingCleared = Boolean(record.pending);
  const unreachable = (message: string): CliError => ({ code: "store-unreachable", message: `${message} ${UNREACHABLE}`, next: [] });
  const asked = fileOnly ? " Only the file was checked, as HAAU3_SESSION_STORE asks." : "";

  if (!record.session) {
    if (pendingCleared) await ctx.store.clear(address);
    if (keyringUnreachable) return failed("logout", unreachable("No session was found in the file."));
    const text = pendingCleared ? "Already signed out. The sign-in that was waiting for approval is cancelled." : "Already signed out.";
    return done("logout", { status: "already-signed-out", revoked: false, pendingCleared, copyLeft: false }, `${text}${asked}\n`);
  }

  const session = record.session;
  const revoked = await endSession(session);
  const { incomplete } = await ctx.store.clear(address);
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
  if (keyringUnreachable) return failed("logout", unreachable("The session in the file is ended and deleted."));
  const left = incomplete ? " A copy of the ended session could not be deleted; it no longer works." : "";
  return done("logout", { status: "signed-out", revoked: true, pendingCleared, copyLeft: incomplete }, `Signed out. The approval has ended too.${left}${asked}\n`);
}
