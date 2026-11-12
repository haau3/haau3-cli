// What every command that calls the API shares, doctor and test alike: what a key found is, where a
// key may go, how a call is made and timed, and what kind of answer came back. Never a key, a value
// found under another name, or a body: only facts about them.
import { AuthError, ForbiddenError, Haau3, Haau3Error, NoAnswerError, RefusedError } from "@haau3/sdk";
import { ENVIRONMENT_ADDRESSES, type Environment } from "./environment.js";
import { modeOf, wellFormed, type KeyMode } from "./key.js";
import type { Problem } from "./output.js";
import type { Found, Settings } from "./settings.js";
import { holdsKey } from "./signin/keys.js";
import { VERSION } from "./version.js";

/** How long each call may take: an instance of the API that was asleep can take up to about 30 s to start. */
export const CALL_TIMEOUT_MS = 30_000;

export const COLD_START = "An instance of the API may have been starting, which can take up to about 30 seconds. Run this again.";

/** Each environment as a sentence names it. */
export const NAMED: Readonly<Record<Environment, string>> = { production: "production", sandbox: "the Sandbox" };

/** A name as it starts a sentence: "the Sandbox" becomes "The Sandbox". */
export const sentence = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

// --- the key -------------------------------------------------------------------------------------

export interface KeyFacts {
  mode: KeyMode;
  wellFormed: boolean;
  /** Something comes before haau3_sk_, such as a quote or "Bearer ". */
  notAlone: boolean;
  /** Only visible ASCII: a key that holds a line break or an invisible character cannot be sent. */
  visible: boolean;
  /** A haau3 key in visible ASCII: the only value a command sends. */
  sendable: boolean;
}

export function keyFacts(found: Found): KeyFacts {
  const value = found.value.trim();
  const at = value.indexOf("haau3_sk_");
  const key = at > 0 ? value.slice(at) : value;
  const mode = modeOf(key);
  const visible = /^[\x21-\x7e]+$/.test(key);
  return { mode, wellFormed: at === 0 && wellFormed(value), notAlone: at > 0, visible, sendable: mode !== "unrecognized" && visible };
}

/** Whether HAAU3_ENVIRONMENT, where the application finds it, names the Sandbox. */
export function sandboxNamed(settings: Settings): boolean {
  return settings.environment?.value.trim().toLowerCase() === "sandbox";
}

// --- where a call goes ---------------------------------------------------------------------------

/**
 * An address as the command line prints it: its origin, and `/…` when it has a path, which can carry a
 * token of a gateway's. haau3's own addresses have none.
 */
export function shownBase(address: string): string {
  const url = new URL(address);
  return url.pathname && url.pathname !== "/" ? `${url.origin}/…` : url.origin;
}

/** Whether the client calls its environment's own address: haau3's, not a stand-in's or a proxy's. */
export function ownAddress(client: Haau3): boolean {
  return client.baseURL === ENVIRONMENT_ADDRESSES[client.environment];
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Where a key is sent: haau3's own two addresses, or this computer (owner, 2026-11-12). A base URL can
 * come from a committed env file, so a project someone else wrote could otherwise collect the key from
 * your shell; any other host is called with no key.
 */
export function keyMayGo(client: Haau3): boolean {
  const { origin, hostname } = new URL(client.baseURL);
  return origin === ENVIRONMENT_ADDRESSES.production || origin === ENVIRONMENT_ADDRESSES.sandbox || LOOPBACK.has(hostname);
}

/** The options every client the command line makes takes: one attempt, the timeout, and haau3-cli in the User-Agent. */
export function clientOptions(fetch: typeof globalThis.fetch | undefined) {
  return { fetch, timeout: CALL_TIMEOUT_MS, maxRetries: 0, appInfo: { name: "haau3-cli", version: VERSION } };
}

// --- what came back ------------------------------------------------------------------------------

/**
 * A request id as the API sends it, a UUID, or nothing: an answer from anything else could carry
 * whatever it was sent, the key included, in that header.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function safeRequestId(id: string | undefined): string | null {
  return id !== undefined && UUID.test(id) ? id : null;
}

/** A code the API names, as the command line repeats one: short, kebab-case, never a key. */
const CODE = /^[a-z][a-z0-9-]{0,63}$/;

/** The longest wait the command line repeats from Retry-After: a day. A longer one is not believed. */
export const MAX_RETRY_AFTER_S = 86_400;

/** The API's own code on an error, when it is one the command line may repeat: never one holding the key. */
function safeCode(error: Haau3Error, key: string | null): string | undefined {
  const code = error.code;
  return code && CODE.test(code) && !(key && holdsKey(code, key)) ? code : undefined;
}

/**
 * An answer's status, code and request id, in the shape every error of the command line carries.
 * Never its body, and never a code that holds any part of the key sent.
 */
export function problemOf(error: unknown, key: string | null): Problem | undefined {
  if (!(error instanceof Haau3Error)) return undefined;
  const status = (error as { status?: unknown }).status;
  if (typeof status !== "number") return undefined;
  const problem: Problem = { type: "about:blank", title: `HTTP ${status}`, status };
  const code = error instanceof ForbiddenError || error instanceof RefusedError ? safeCode(error, key) : undefined;
  if (code) problem.code = code;
  const requestId = safeRequestId(error.requestId);
  if (requestId) problem.requestId = requestId;
  return problem;
}

/** What kind of answer a call that did not succeed got, as doctor and test sort it. */
export type Refusal =
  | "bad-key"
  | "wrong-key-mode"
  | "needs-an-agreement"
  | "not-open-to-customers"
  | "not-the-example"
  | "refused"
  | "over-a-limit"
  | "no-answer"
  | "unreachable"
  | "unreadable"
  | "not-sent"
  | "error";

export interface Sorted {
  answer: Refusal;
  /** The answer's status and safe code and request id, when the API answered. */
  problem?: Problem;
  /** Why there was no answer, when there was none. */
  reason?: NoAnswerError["reason"];
  /** What failed, for a timeout or a network failure: a system code or an error's name, never a message. */
  detail?: string | null;
  /** Seconds to wait, from Retry-After, when it is a day or less. */
  retryAfter?: number;
  /** The error's name, for an error the command line does not know. */
  name?: string;
}

const KEY_MODE_CODES = new Set(["test-key-outside-sandbox", "live-key-in-sandbox"]);

/** Sorts what the SDK threw into the kinds of answer the command line reports, by class and code, never by message. */
export function sortError(error: unknown, key: string | null): Sorted {
  const problem = problemOf(error, key);
  if (error instanceof AuthError) return { answer: "bad-key", problem };
  if (error instanceof ForbiddenError) {
    const code = problem?.code;
    if (code && KEY_MODE_CODES.has(code)) return { answer: "wrong-key-mode", problem };
    if (code === "phi-agreement-required") return { answer: "needs-an-agreement", problem };
    if (code === "not-open-to-customers") return { answer: "not-open-to-customers", problem };
    return { answer: "refused", problem };
  }
  if (error instanceof RefusedError) return { answer: problem?.code === "not-the-example" ? "not-the-example" : "refused", problem };
  if (error instanceof NoAnswerError) {
    const base = { problem, reason: error.reason, detail: error.detail ?? null };
    if (error.reason === "rate-limited") {
      const wait = error.retryAfter !== undefined && Number.isFinite(error.retryAfter) && error.retryAfter <= MAX_RETRY_AFTER_S ? error.retryAfter : undefined;
      return { answer: "over-a-limit", ...base, ...(wait !== undefined ? { retryAfter: wait } : {}) };
    }
    if (error.reason === "network") return { answer: "unreachable", ...base };
    if (error.reason === "unreadable") return { answer: "unreadable", ...base };
    return { answer: "no-answer", ...base };
  }
  if (error instanceof Haau3Error) return { answer: "not-sent", name: error.name };
  return { answer: "error", name: error instanceof Error ? error.name : "an error" };
}
