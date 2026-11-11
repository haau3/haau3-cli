// What every command does with the stored session: read it with the two stores reconciled, end it,
// and tell when it ends on this computer's clock.
import { revoke, type PendingSignIn } from "../signin/device.js";
import type { Session, SessionRecord } from "../session/record.js";
import type { Where } from "../session/store.js";
import type { Context } from "./context.js";

/** How long revoking may take inside a command that has a limit to keep. */
export const REVOKE_TIMEOUT_MS = 5_000;

export interface Current {
  record: SessionRecord;
  where: Where | null;
  keyringUnreachable: boolean;
  fileOnly: boolean;
}

/**
 * The address's record. When both stores hold one (a run in a sandbox wrote to the file while the
 * credential store held another), they become one: the session that ends last is kept and the other's
 * grant is ended first, so no session is deleted while its token still works.
 */
export async function loadRecord(ctx: Context, address: string): Promise<Current> {
  const loaded = await ctx.store.load(address);
  const { keyringUnreachable, fileOnly } = loaded;
  if (!loaded.other) return { record: loaded.record, where: loaded.where, keyringUnreachable, fileOnly };

  const mine = loaded.record;
  const theirs = loaded.other.record;
  let session = mine.session ?? theirs.session;
  if (mine.session && theirs.session && mine.session.accessToken.reveal() !== theirs.session.accessToken.reveal()) {
    const [keep, drop] = mine.session.expiresAt >= theirs.session.expiresAt ? [mine.session, theirs.session] : [theirs.session, mine.session];
    await endSession(drop);
    session = keep;
  }
  const record: SessionRecord = {};
  if (session) record.session = session;
  const pending = mine.pending ?? theirs.pending;
  if (pending) record.pending = pending;
  const where = await ctx.store.save(address, record);
  return { record, where: where ?? loaded.where, keyringUnreachable, fileOnly };
}

/** Ends the grant a session's token belongs to. True when the sign-in service said it did. */
export function endSession(session: Session, timeoutMs: number = REVOKE_TIMEOUT_MS): Promise<boolean> {
  return revoke(session.accessToken, session.revocationEndpoint, session.clientId, timeoutMs);
}

/**
 * Ends a session the platform no longer takes, or whose end has passed: its grant revoked, then its
 * stored copy deleted, but only while the store still holds this session. The store is read again
 * first, so a session another run kept meanwhile (a `login --complete` that finished while this one
 * waited on the platform) stays, as does whatever another run did to a waiting sign-in.
 */
export async function endStoredSession(ctx: Context, address: string, session: Session): Promise<void> {
  await endSession(session);
  const latest = await ctx.store.load(address);
  const stored = latest.record.session;
  if (stored && stored.accessToken.reveal() !== session.accessToken.reveal()) return;
  const other = latest.other?.record.session;
  if (other && other.accessToken.reveal() !== session.accessToken.reveal()) return;
  await ctx.store.save(address, latest.record.pending ? { pending: latest.record.pending } : {});
}

/** Whether two waiting sign-ins are the same one: the same device code. */
export function sameCode(a: PendingSignIn | undefined, b: PendingSignIn | undefined): boolean {
  return Boolean(a && b && a.deviceCode.reveal() === b.deviceCode.reveal());
}

/**
 * When the platform's end falls on this computer's clock. The platform says when on its own clock, and
 * its answer's Date header says what its clock read then, so the session's length carries over whatever
 * this computer's clock says. Without a Date header, the two clocks are taken to agree.
 */
export function endOnThisClock(platformEnd: string, platformNow: number | undefined, now: number): number {
  return now + (Date.parse(platformEnd) - (platformNow ?? now));
}
