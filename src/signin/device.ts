// The device authorization grant (RFC 8628), the command line's half: ask for a code, then ask the
// token endpoint whether the person has approved it, at the pace the sign-in service sets, until they
// approve, refuse or the code expires. Revocation (RFC 7009) ends a session.
//
// The token endpoint also hands back a refresh token. The command line never keeps or uses one: it is
// dropped where the answer is read, so a session cannot outlive its access token.
import { isSafeAddress } from "../environment.js";
import type { CliError } from "../output.js";
import type { SignInService } from "./discovery.js";
import { signInUnreachable } from "./discovery.js";
import { call, isRecord, retryAfterSeconds, text } from "./http.js";
import { AccessToken, DeviceCode } from "./secret.js";

export const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

/** A sign-in waiting for a person to approve it in the browser. */
export interface PendingSignIn {
  deviceCode: DeviceCode;
  userCode: string;
  /** The page the person opens. Never the one with the code filled in (RFC 8628, section 5.4). */
  verificationUri: string;
  /** When the code stops working, in milliseconds since the epoch. */
  expiresAt: number;
  /** Seconds between two polls. Raised by a slow_down answer and kept for the next run. */
  interval: number;
  service: SignInService;
}

export type StartResult = { ok: true; pending: PendingSignIn } | { ok: false; error: CliError };

const DEFAULT_INTERVAL = 5;
/** A code a person types (RFC 8628, section 6.1): letters and digits, with dashes between. */
export const USER_CODE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38}[A-Za-z0-9])?$/;
const OAUTH_ERROR = /^[a-z_]{1,40}$/;

export async function startSignIn(service: SignInService, now: number): Promise<StartResult> {
  const form: Record<string, string> = { client_id: service.clientId };
  if (service.scope) form.scope = service.scope;
  const answer = await call(service.deviceEndpoint, { form });
  const host = new URL(service.issuer).host;
  if (!answer.answered || answer.status >= 500) return { ok: false, error: signInUnreachable(host) };
  const body = answer.body;
  if (answer.status !== 200 || !isRecord(body)) return { ok: false, error: refused(oauthError(body)) };

  const deviceCode = text(body.device_code, 2000);
  const userCode = text(body.user_code, 40);
  const verificationUri = page(body.verification_uri, service.platformURL);
  const expiresIn = seconds(body.expires_in, 86_400);
  const interval = body.interval === undefined ? DEFAULT_INTERVAL : seconds(body.interval, 600);
  if (!deviceCode || !userCode || !USER_CODE.test(userCode) || !verificationUri || !expiresIn || !interval) {
    return {
      ok: false,
      error: { code: "unexpected-answer", message: `The sign-in service at ${host} answered with a code haau3 cannot use.`, next: [] },
    };
  }
  return {
    ok: true,
    pending: { deviceCode: new DeviceCode(deviceCode), userCode, verificationUri, expiresAt: now + expiresIn * 1000, interval, service },
  };
}

export type PollOutcome =
  | { kind: "approved"; token: AccessToken; expiresIn: number | undefined }
  | { kind: "pending" }
  | { kind: "slow-down" }
  | { kind: "expired" }
  | { kind: "denied" }
  /** No answer, or one with no OAuth error to read (a 5xx, a 429, a 408): wait longer and ask again. */
  | { kind: "transient"; retryAfterMs: number }
  | { kind: "failed"; reason: string | undefined };

/** How long one poll may take, so a run's limit is kept even when the server is slow. */
export const POLL_TIMEOUT_MS = 10_000;

/** One question to the token endpoint (RFC 8628, sections 3.4 and 3.5). */
export async function pollOnce(pending: PendingSignIn, timeoutMs: number = POLL_TIMEOUT_MS): Promise<PollOutcome> {
  const answer = await call(pending.service.tokenEndpoint, {
    form: { grant_type: DEVICE_GRANT, device_code: pending.deviceCode.reveal(), client_id: pending.service.clientId },
    timeoutMs,
  });
  if (!answer.answered) return { kind: "transient", retryAfterMs: 0 };
  const body = answer.body;
  // An OAuth error is read whatever the status it came with.
  const error = oauthError(body);
  if (error === "authorization_pending") return { kind: "pending" };
  if (error === "slow_down") return { kind: "slow-down" };
  if (error === "expired_token") return { kind: "expired" };
  if (error === "access_denied") return { kind: "denied" };
  if (error) return { kind: "failed", reason: error };

  if (answer.status === 200 && isRecord(body)) {
    const accessToken = text(body.access_token, 4096);
    if (!accessToken) return { kind: "failed", reason: undefined };
    const token = new AccessToken(accessToken);
    // RFC 6749, section 5.1 makes token_type required; one the command line does not use is not used.
    // An answer that leaves it out is read as Bearer, the only type these endpoints issue.
    const type = body.token_type === undefined ? "bearer" : typeof body.token_type === "string" ? body.token_type.toLowerCase() : "";
    if (type !== "bearer") {
      await revoke(token, pending.service.revocationEndpoint, pending.service.clientId);
      return { kind: "failed", reason: undefined };
    }
    // Only the access token is read. The refresh token stays in the answer, which goes out of scope here.
    const expiresIn = typeof body.expires_in === "number" && Number.isInteger(body.expires_in) && body.expires_in > 0 ? body.expires_in : undefined;
    return { kind: "approved", token, expiresIn };
  }
  // Rate limited, timed out, or the server's own trouble: the code still works.
  if (answer.status === 429 || answer.status === 408 || answer.status >= 500) {
    return { kind: "transient", retryAfterMs: (retryAfterSeconds(answer.headers) ?? 0) * 1000 };
  }
  return { kind: "failed", reason: undefined };
}

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export type WaitOutcome =
  | { kind: "approved"; token: AccessToken; expiresIn: number | undefined }
  | { kind: "expired" }
  | { kind: "denied" }
  | { kind: "failed"; reason: string | undefined }
  /** The run's own limit came before an answer: the code still works, and another run can wait on. */
  | { kind: "still-pending" };

/** How long a failure can push the next poll back (RFC 8628, section 3.5's backoff). Never below the interval. */
const MAX_BACKOFF_MS = 60_000;

/** The last poll lands at least this long before the code expires. */
const EXPIRY_MARGIN_MS = 1_000;

/**
 * Polls until the person answers, the code expires or the run's `deadline` comes, a poll's own time
 * included. Each poll waits the interval first, since the run before may have polled moments ago, and
 * never less: a backoff may be cut short so the last poll lands before the code expires, the interval
 * may not. `onSlowDown` keeps a raised interval for the runs after this one.
 */
export async function waitForApproval(
  pending: PendingSignIn,
  deadline: number,
  clock: Clock,
  onSlowDown: (pending: PendingSignIn) => Promise<void>,
): Promise<WaitOutcome> {
  let failures = 0;
  let retryAfterMs = 0;
  for (;;) {
    const interval = pending.interval * 1000;
    const backoff = Math.max(Math.min(interval * 2 ** failures, MAX_BACKOFF_MS), retryAfterMs);
    const left = pending.expiresAt - clock.now() - EXPIRY_MARGIN_MS;
    const wait = Math.max(interval, Math.min(backoff, left));
    if (wait > left) return { kind: "expired" };
    if (clock.now() + wait + POLL_TIMEOUT_MS > deadline) return { kind: "still-pending" };
    await clock.sleep(wait);
    retryAfterMs = 0;
    const outcome = await pollOnce(pending);
    switch (outcome.kind) {
      case "pending":
        failures = 0;
        break;
      case "slow-down":
        // RFC 8628, section 3.5: five seconds more, for this poll and every one after it.
        failures = 0;
        pending.interval += 5;
        await onSlowDown(pending);
        break;
      case "transient":
        failures = Math.min(failures + 1, 4);
        retryAfterMs = outcome.retryAfterMs;
        break;
      default:
        return outcome;
    }
  }
}

/** Ends the grant the token belongs to (RFC 7009). True when the sign-in service said it did. */
export async function revoke(token: AccessToken, revocationEndpoint: string, clientId: string, timeoutMs?: number): Promise<boolean> {
  const answer = await call(revocationEndpoint, {
    form: { token: token.reveal(), token_type_hint: "access_token", client_id: clientId },
    timeoutMs,
  });
  return answer.answered && answer.status === 200;
}

/** The OAuth error code of a refusal (RFC 6749, section 5.2), when it has a code's shape. */
function oauthError(body: unknown): string | undefined {
  if (!isRecord(body) || typeof body.error !== "string") return undefined;
  return OAUTH_ERROR.test(body.error) ? body.error : undefined;
}

function refused(error: string | undefined): CliError {
  return {
    code: "sign-in-failed",
    message: error ? `The sign-in service would not start a sign-in (${error}).` : "The sign-in service would not start a sign-in.",
    next: [{ command: "npx haau3 login", description: "Try signing in again." }],
  };
}

/**
 * The page a person opens: https, or http on this computer only when the platform itself is, with no
 * user, query or fragment, so a code filled in can never ride along. Returned as the parser reads it,
 * so what is printed is what the browser would open.
 */
export function page(value: unknown, platformURL: string): string | undefined {
  const raw = text(value, 500);
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    const local = url.protocol === "http:";
    if (!isSafeAddress(url) || (local && new URL(platformURL).protocol !== "http:")) return undefined;
    if (url.username || url.password || url.search || url.hash) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

function seconds(value: unknown, max: number): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= max ? value : undefined;
}
