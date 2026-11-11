// Every request signing in makes: to the platform and to the sign-in service it names. Each carries
// the command line's name and version, is bounded in time and in the size of what it reads back, and
// follows no redirect, so a token is only ever sent to the address the command line chose.
import type { Problem } from "../output.js";
import { VERSION } from "../version.js";
import type { AccessToken } from "./secret.js";

export const USER_AGENT = `haau3-cli/${VERSION}`;

const TIMEOUT_MS = 30_000;
const MAX_BODY_BYTES = 64 * 1024;

export interface HttpRequest {
  /** Sent as application/x-www-form-urlencoded, which OAuth's endpoints take; makes it a POST. */
  form?: Record<string, string>;
  bearer?: AccessToken;
}

/** An answer, its body parsed when it is JSON; or no answer at all. */
export type HttpResult =
  | { answered: true; status: number; headers: Headers; body: unknown }
  | { answered: false };

export async function call(url: string, request: HttpRequest = {}): Promise<HttpResult> {
  const headers: Record<string, string> = { "User-Agent": USER_AGENT, Accept: "application/json" };
  let body: string | undefined;
  if (request.form) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(request.form).toString();
  }
  if (request.bearer) headers.Authorization = `Bearer ${request.bearer.reveal()}`;
  try {
    const response = await fetch(url, {
      method: request.form ? "POST" : "GET",
      headers,
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await readBounded(response);
    return { answered: true, status: response.status, headers: response.headers, body: parseJson(text) };
  } catch {
    // Only that there was no answer: an error's message can carry what the request was holding.
    return { answered: false };
  }
}

async function readBounded(response: Response): Promise<string | undefined> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseJson(text: string | undefined): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A string field of at most `max` characters with no control characters, or undefined. */
export function text(value: unknown, max = 300): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > max) return undefined;
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u001f\u007f]/.test(value) ? undefined : value;
}

const CODE = /^[a-z0-9][a-z0-9_-]{0,59}$/;
const REQUEST_ID = /^[\w.:-]{1,100}$/;

/** The answer's RFC 9457 problem: its type, title, status, code and request id, never its detail. */
export function problemOf(result: { status: number; headers: Headers; body: unknown }): Problem {
  const body = isRecord(result.body) ? result.body : {};
  const problem: Problem = {
    type: text(body.type, 300) ?? "about:blank",
    title: text(body.title, 120) ?? `HTTP ${result.status}`,
    status: result.status,
  };
  const code = typeof body.code === "string" && CODE.test(body.code) ? body.code : undefined;
  if (code) problem.code = code;
  const requestId = result.headers.get("x-request-id");
  if (requestId && REQUEST_ID.test(requestId)) problem.requestId = requestId;
  return problem;
}

/** Retry-After in whole seconds, when the answer gives it as a number (RFC 9110, section 10.2.3). */
export function retryAfterSeconds(headers: Headers): number | undefined {
  const value = headers.get("retry-after")?.trim();
  if (!value || !/^\d{1,6}$/.test(value)) return undefined;
  return Number(value);
}
