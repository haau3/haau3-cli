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
  /** Sent as application/json, which the platform's own endpoints take; makes it a POST. */
  json?: Record<string, unknown>;
  bearer?: AccessToken;
  /** How long the request may take, the body included. 30 seconds unless the caller has less to spare. */
  timeoutMs?: number;
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
  } else if (request.json) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(request.json);
  }
  if (request.bearer) headers.Authorization = `Bearer ${request.bearer.reveal()}`;
  try {
    const response = await fetch(url, {
      method: body === undefined ? "GET" : "POST",
      headers,
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(Math.max(1, request.timeoutMs ?? TIMEOUT_MS)),
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

/**
 * Characters a terminal can act on, or that change how text reads without showing: C0 and C1 control
 * characters (C1 includes CSI and OSC, which some terminals obey), format characters (the bidi
 * overrides among them) and the line and paragraph separators.
 */
const UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const UNSAFE_ALL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
/** The joiners emoji sequences need. Shown as they are; nothing else in UNSAFE is. */
const JOINERS = /[‌‍]/;

/** A protocol value (a code, an address, an id) of at most `max` characters with no unsafe character, or undefined. */
export function text(value: unknown, max = 300): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > max) return undefined;
  return UNSAFE.test(value) ? undefined : value;
}

/**
 * A name to show a person (an organization, an email, a plan), at most `max` characters, with every
 * unsafe character but the emoji joiners replaced by U+FFFD, so a name someone else chose can neither
 * steer the terminal nor read as something it is not. Undefined when it is not a string, or empty.
 */
export function displayText(value: unknown, max = 300): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > max) return undefined;
  return value.replace(UNSAFE_ALL, (c) => (JOINERS.test(c) ? c : "�"));
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

/** The answer's Date header (RFC 9110, section 6.6.1) in milliseconds since the epoch, when it has one. */
export function dateOf(headers: Headers): number | undefined {
  const value = headers.get("date");
  const at = value ? Date.parse(value) : Number.NaN;
  return Number.isNaN(at) ? undefined : at;
}

/** Retry-After in whole seconds, when the answer gives it as a number (RFC 9110, section 10.2.3). */
export function retryAfterSeconds(headers: Headers): number | undefined {
  const value = headers.get("retry-after")?.trim();
  if (!value || !/^\d{1,6}$/.test(value)) return undefined;
  return Number(value);
}
