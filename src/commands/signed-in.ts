// What a command that acts through the session needs before it asks the platform anything, and what
// it does when the platform no longer takes the session: shared by `keys list` and `keys revoke`.
import { findKey } from "../key.js";
import type { CliError } from "../output.js";
import type { Session } from "../session/record.js";
import type { ListedKey, SessionAnswer } from "../signin/keys.js";
import { COMPLETE_STEP, LOGIN_STEP, when, type Context } from "./context.js";
import { organizationError } from "./login.js";
import { endStoredSession, loadRecord } from "./session.js";

export type SignedIn = { ok: true; session: Session } | { ok: false; error: CliError };

/** The session kept for this platform, or why there is none to use. A session past its end is ended here. */
export async function signedIn(ctx: Context, address: string): Promise<SignedIn> {
  const { record, keyringUnreachable } = await loadRecord(ctx, address);
  const session = record.session;
  if (!session) {
    if (record.pending && record.pending.expiresAt > ctx.now()) {
      return { ok: false, error: { code: "not-signed-in", message: "Not signed in yet: a sign-in is waiting for approval.", next: [COMPLETE_STEP] } };
    }
    const unseen = keyringUnreachable ? " The system's credential store could not be reached, so a session kept there could not be checked." : "";
    return { ok: false, error: { code: "not-signed-in", message: `Not signed in.${unseen} Sign in, then run this again.`, next: [LOGIN_STEP] } };
  }
  if (session.expiresAt <= ctx.now()) {
    await endStoredSession(ctx, address, session);
    return {
      ok: false,
      error: { code: "session-ended", message: `The session ended at ${when(session.expiresAt, ctx.now())}. Sign in again, then run this again.`, next: [LOGIN_STEP] },
    };
  }
  return { ok: true, session };
}

/** The platform no longer takes the session, or the member left its organization: ended here too, then said. */
export async function sessionRefused(ctx: Context, address: string, session: Session, answer: SessionAnswer): Promise<CliError> {
  await endStoredSession(ctx, address, session);
  if (answer.kind === "ended") {
    return { code: "session-ended", message: "The session has ended. Sign in again, then run this again.", next: [LOGIN_STEP], problem: answer.problem };
  }
  return organizationError(answer.code, answer.problem, session.organization.name);
}

/** The project's key, as far as the keys page shows one: where the application finds it, and its prefix. */
export interface ProjectKey {
  /** `environment`, or the env file as it is printed. */
  source: string;
  prefix: string;
}

const PREFIX = /^haau3_sk_(?:live_|test_)?[A-Za-z0-9_-]{6}$/;

/**
 * The key this project uses, found where the application finds it (the environment, then its env
 * files), told by the part of it the keys page shows. Null when there is none, or it is not a haau3
 * key: nothing of a value that is not one is ever repeated.
 */
export function projectKeyOf(ctx: Context): ProjectKey | null {
  const found = findKey({ cwd: ctx.cwd, env: ctx.env });
  if (found.report.status !== "found" || !found.key) return null;
  const { mode, source } = found.report;
  if (mode === "unrecognized") return null;
  const head = mode === "live" ? "haau3_sk_live_" : mode === "test" ? "haau3_sk_test_" : "haau3_sk_";
  const prefix = found.key.reveal().slice(0, head.length + 6);
  return PREFIX.test(prefix) ? { source, prefix } : null;
}

/** Where this project uses the key, or null when it does not. */
export function usedHere(project: ProjectKey | null, key: ListedKey): string | null {
  return project !== null && project.prefix === key.prefix ? project.source : null;
}

/** A listed key as a document carries it: everything the platform said of it, never a secret. */
export function keyData(key: ListedKey, inUse: string | null) {
  return {
    id: key.id,
    name: key.name,
    prefix: key.prefix,
    mode: key.mode,
    createdAt: key.createdAt,
    createdVia: key.createdVia,
    lastUsedAt: key.lastUsedAt,
    revokedAt: key.revokedAt,
    managed: key.managed,
    inUse,
  };
}

/** A day in this computer's time zone, as 2026-11-12. */
export function day(at: string): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const MODE_WORDS: Record<ListedKey["mode"], string> = {
  live: "live",
  test: "test, the Sandbox only",
  both: "made before modes, works in both",
};

/** A key as a person reads it, indented under its name. */
export function keyLines(key: ListedKey, inUse: string | null): string[] {
  const badges = [key.managed ? "managed" : null, key.createdVia === "cli" ? "made from the command line" : null, key.revokedAt ? "revoked" : null].filter(Boolean);
  const lines = [`${key.name}${badges.length ? ` (${badges.join(", ")})` : ""}`];
  lines.push(`  ${key.prefix}…  ${MODE_WORDS[key.mode]}`);
  lines.push(`  Made ${day(key.createdAt)}. ${key.lastUsedAt ? `Last used ${day(key.lastUsedAt)}.` : "Never used."}${key.revokedAt ? ` Revoked ${day(key.revokedAt)}.` : ""}`);
  if (key.managed) lines.push("  The dashboard's playgrounds use it. It cannot be revoked.");
  if (inUse) lines.push(`  This project uses it: ${inUse === "environment" ? "this shell's HAAU3_API_KEY" : inUse}.`);
  lines.push(`  Id: ${key.id}`);
  return lines;
}
