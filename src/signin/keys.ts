// The platform's answer to "make a key": a new API key for the organization the session was approved
// for, made the way the dashboard makes one and marked as made from the command line. The answer
// carries the key's secret this once. It goes straight into an ApiKey, which prints as hidden, and is
// checked to be exactly a key of the mode asked for, so nothing else can ever be written to the file.
import { ApiKey } from "../key.js";
import type { CliError, NextStep, Problem } from "../output.js";
import { CLI_API_PATH, platformUnavailable, signInUnavailable } from "./discovery.js";
import { call, displayText, holdsSecret, isRecord, mayHoldSecret, problemOf, text } from "./http.js";
import type { AccessToken } from "./secret.js";

export type KeyMode = "live" | "test";

export interface CreatedKey {
  id: string;
  name: string;
  /** The part of the key the keys page shows. */
  prefix: string;
  mode: KeyMode;
  secret: ApiKey;
}

/** What is known of a key the platform made but whose answer could not be used. */
export interface MadeKey {
  id: string | null;
  name: string | null;
  prefix: string | null;
}

export type CreateResult =
  | { kind: "ok"; key: CreatedKey }
  /** The platform no longer takes the session. */
  | { kind: "ended"; problem: Problem }
  /** The member is not in the session's organization, or picked none. */
  | { kind: "no-organization"; code: "not-a-member" | "no-organization"; problem: Problem }
  /**
   * A key may exist: the platform made one and its answer could not be used, it failed, or no answer
   * came. `signInEnded` when the platform answered with a success, which it gives only after ending the
   * sign-in; otherwise the sign-in may or may not have ended.
   */
  | { kind: "unknown"; made: MadeKey | null; error: CliError; signInEnded: boolean }
  | { kind: "error"; error: CliError };

/** The characters a key is made of, after its mode's prefix. */
const KEY_RANDOM = /^[A-Za-z0-9_-]{20,200}$/;

/** How long the platform may take to make a key. */
export const CREATE_TIMEOUT_MS = 30_000;

export async function createKey(platformURL: string, token: AccessToken, request: { name: string; mode: KeyMode }): Promise<CreateResult> {
  const host = new URL(platformURL).host;
  const answer = await call(`${platformURL}${CLI_API_PATH}/keys`, { json: { name: request.name, mode: request.mode }, bearer: token, timeoutMs: CREATE_TIMEOUT_MS });
  if (!answer.answered) {
    return {
      kind: "unknown",
      made: null,
      signInEnded: false,
      error: {
        code: "platform-unreachable",
        message: `${host} did not answer. A key may have been made without reaching this computer: look on the keys page at ${platformURL}/dashboard/keys, and revoke any you do not recognise.`,
        next: [],
      },
    };
  }
  if (answer.status === 201) {
    const key = parseCreated(answer.body, request.mode);
    if (key) return { kind: "ok", key };
  }
  if (answer.status >= 200 && answer.status < 300) {
    // Any success may have made a key: one this command cannot use, and nobody else holds.
    return {
      kind: "unknown",
      made: madeKey(answer.body),
      signInEnded: true,
      error: {
        code: "unexpected-answer",
        message: `${host} answered in a way haau3 cannot use (HTTP ${answer.status}), so nothing was written, and it may have made a key. Revoke any you do not recognise on the keys page at ${platformURL}/dashboard/keys.`,
        next: [{ command: "npx haau3@latest --version", description: "Check for a newer haau3." }],
        // Its status and request id only, the id left out if it holds any of the key the answer gave.
        problem: problemOf(answer, (value) => holdsKey(value, isRecord(answer.body) ? answer.body.secret : undefined)),
      },
    };
  }
  const problem = problemOf(answer);
  if (answer.status === 401) return { kind: "ended", problem };
  if (answer.status === 403 && (problem.code === "not-a-member" || problem.code === "no-organization")) {
    return { kind: "no-organization", code: problem.code, problem };
  }
  if (answer.status === 404) return { kind: "error", error: signInUnavailable(platformURL, answer) };
  if (answer.status >= 500) {
    // The platform bounds how long it waits for the database without stopping the write, so an error
    // can come back for a key that was made. Trying again without looking would make a second one.
    const unavailable = platformUnavailable(host, answer);
    return {
      kind: "unknown",
      made: null,
      // The platform may have ended the sign-in before failing.
      signInEnded: false,
      error: { ...unavailable, message: `${unavailable.message} It may have made a key anyway: look on the keys page at ${platformURL}/dashboard/keys before trying again, and revoke any you do not recognise.` },
    };
  }
  return {
    kind: "error",
    error: { code: "unexpected-answer", message: `${host} refused to make the key (HTTP ${answer.status}).`, next: [{ command: "npx haau3@latest --version", description: "Check for a newer haau3." }], problem },
  };
}

/** A key's id as the platform gives one: a uuid today, and nothing a terminal or a shell would act on. */
const ID = /^[A-Za-z0-9_-]{1,64}$/;

/** The part of a key the keys page shows: the mode's prefix and six characters, exactly. */
const PREFIX = /^haau3_sk_(?:live|test)_[A-Za-z0-9_-]{6}$/;

/**
 * Whether a value the answer gives beside the key holds any of it: a key's marker, or eight characters
 * running of the key's random part (the prefix the keys page shows holds six). Only a broken platform
 * would send one, and then it is never printed.
 */
export function holdsKey(value: string, secret: unknown): boolean {
  if (/haau3_sk_/i.test(value)) return true;
  if (typeof secret !== "string") return false;
  return holdsSecret(value, secret.replace(/^haau3_sk_(?:live|test)_/, ""));
}

/** The 201, or undefined unless it holds exactly a key of the mode asked for and the facts about it. */
export function parseCreated(body: unknown, mode: KeyMode): CreatedKey | undefined {
  if (!isRecord(body)) return undefined;
  const secret = body.secret;
  const start = `haau3_sk_${mode}_`;
  if (body.mode !== mode || typeof secret !== "string") return undefined;
  if (!secret.startsWith(start) || !KEY_RANDOM.test(secret.slice(start.length))) return undefined;
  const id = shownId(body.id, secret);
  const name = shownName(body.name, secret);
  const prefix = shownKeyPrefix(body.keyPrefix);
  if (!id || !name || !prefix || !prefix.startsWith(start) || !secret.startsWith(prefix)) return undefined;
  return { id, name, prefix, mode, secret: new ApiKey(secret) };
}

function shownId(value: unknown, secret: unknown): string | undefined {
  const id = text(value, 64);
  return id && ID.test(id) && !holdsKey(id, secret) ? id : undefined;
}

function shownName(value: unknown, secret: unknown): string | undefined {
  const name = displayText(value, 200);
  return name && !holdsKey(name, secret) ? name : undefined;
}

function shownKeyPrefix(value: unknown): string | undefined {
  const prefix = text(value, 30);
  return prefix && PREFIX.test(prefix) ? prefix : undefined;
}

/** What can be said of a key from an answer that could not be used: never any of its secret. */
function madeKey(body: unknown): MadeKey | null {
  if (!isRecord(body)) return null;
  return {
    id: shownId(body.id, body.secret) ?? null,
    name: shownName(body.name, body.secret) ?? null,
    prefix: shownKeyPrefix(body.keyPrefix) ?? null,
  };
}

// Listing, reading and revoking keys. Each key the platform describes is held to its exact
// shape, as a new key is, and a name that could hold a key is never shown: a key cannot be read back
// from the platform, but a person can name a key anything on the keys page, a key included.

/** A key's id as the platform gives one: a uuid. The only thing `keys revoke` sends in its path. */
const KEY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether a value is shaped like a key's id. It says nothing about whether the key exists. */
export function isKeyId(value: string): boolean {
  return KEY_ID.test(value);
}

/** The part of a listed key the keys page shows: its mode's prefix (none for a key made before modes) and six characters. */
const LISTED_PREFIX = /^haau3_sk_(?:live_|test_)?[A-Za-z0-9_-]{6}$/;

/** Shown in place of a name that could hold a secret (mayHoldSecret). */
export const HIDDEN_NAME = "[a name that may hold a secret, not shown]";

/** One of the organization's keys, as the keys page lists it. Never a secret. */
export interface ListedKey {
  id: string;
  /** The key's name, any character a terminal could act on replaced, or HIDDEN_NAME. */
  name: string;
  /**
   * Whether a person can type `name` exactly as it is shown, so it can confirm a revoke: shown as it
   * is, and made only of visible letters, digits, punctuation, symbols and single spaces.
   */
  nameAsIs: boolean;
  prefix: string;
  /** `both` for a key made before modes, which works in production and the Sandbox. */
  mode: "live" | "test" | "both";
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  /** One of the playground keys the dashboard keeps, which no one revokes. */
  managed: boolean;
  createdVia: "dashboard" | "cli";
}

/**
 * A time exactly as the platform writes one, ISO 8601 with its offset (2026-11-12T15:00:00.000Z), and
 * nothing else: Date.parse alone takes free text such as "1 (anything)".
 */
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

export function time(value: unknown): string | undefined {
  const at = text(value, 40);
  return at && ISO_TIME.test(at) && !Number.isNaN(Date.parse(at)) ? at : undefined;
}

function nullableTime(value: unknown): string | null | undefined {
  return value === null ? null : time(value);
}

/** Letters, digits, punctuation, symbols and the plain space: what a keyboard types and a terminal shows. */
const TYPEABLE = /^[\p{L}\p{N}\p{P}\p{S} ]+$/u;
/** Letters that show as nothing: the Hangul fillers and the blank Braille pattern. */
const BLANK_LETTERS = /[ᅟᅠㅤﾠ⠀]/;

/** Whether a person can type a name exactly as it is shown. */
export function typeable(name: string): boolean {
  return name === name.trim() && !name.includes("  ") && TYPEABLE.test(name) && !BLANK_LETTERS.test(name);
}

/**
 * A key the platform described, or undefined unless every field has exactly its shape. `bearer` is
 * the token the request was sent with: a name holding any of it is never shown.
 */
export function parseListedKey(value: unknown, bearer?: string): ListedKey | undefined {
  if (!isRecord(value)) return undefined;
  const id = text(value.id, 64);
  const prefix = text(value.keyPrefix, 30);
  const raw = typeof value.name === "string" ? value.name : undefined;
  const shown = displayText(raw, 200);
  const createdAt = time(value.createdAt);
  const lastUsedAt = nullableTime(value.lastUsedAt);
  const revokedAt = nullableTime(value.revokedAt);
  const { mode, managed, createdVia } = value;
  if (!id || !KEY_ID.test(id) || !prefix || !LISTED_PREFIX.test(prefix) || !shown || !createdAt) return undefined;
  if (lastUsedAt === undefined || revokedAt === undefined || typeof managed !== "boolean") return undefined;
  if (mode !== "live" && mode !== "test" && mode !== "both") return undefined;
  if (createdVia !== "dashboard" && createdVia !== "cli") return undefined;
  // A key's prefix names its mode, and the two must agree; a key made before modes names neither.
  const named = prefix.startsWith("haau3_sk_live_") ? "live" : prefix.startsWith("haau3_sk_test_") ? "test" : "both";
  if (named !== mode) return undefined;
  const hidden = mayHoldSecret(raw ?? "", bearer) || mayHoldSecret(shown, bearer);
  return {
    id,
    name: hidden ? HIDDEN_NAME : shown,
    nameAsIs: !hidden && shown === raw && typeable(shown),
    prefix,
    mode,
    createdAt,
    lastUsedAt,
    revokedAt,
    managed,
    createdVia,
  };
}

/** The organization's keys as the platform listed them: at most a page, newest first. */
export interface KeyList {
  keys: ListedKey[];
  /** More keys match than these. */
  hasMore: boolean;
  /** How many revoked keys were left out. */
  revokedOmitted: number;
}

/** The most keys one answer may hold. */
const PAGE_MAX = 100;

export function parseKeyList(body: unknown, bearer?: string): KeyList | undefined {
  if (!isRecord(body) || !Array.isArray(body.keys) || body.keys.length > PAGE_MAX) return undefined;
  const { hasMore, revokedOmitted } = body;
  if (typeof hasMore !== "boolean" || !Number.isSafeInteger(revokedOmitted) || (revokedOmitted as number) < 0) return undefined;
  const keys: ListedKey[] = [];
  for (const entry of body.keys) {
    const key = parseListedKey(entry, bearer);
    if (!key) return undefined;
    keys.push(key);
  }
  return { keys, hasMore, revokedOmitted: revokedOmitted as number };
}

/** What every key request can answer besides its own: the session over, or not in its organization. */
export type SessionAnswer =
  /** The platform no longer takes the session. */
  | { kind: "ended"; problem: Problem }
  /** The member is not in the session's organization, or picked none. */
  | { kind: "no-organization"; code: "not-a-member" | "no-organization"; problem: Problem };

function sessionAnswer(status: number, problem: Problem): SessionAnswer | undefined {
  if (status === 401) return { kind: "ended", problem };
  if (status === 403 && (problem.code === "not-a-member" || problem.code === "no-organization")) {
    return { kind: "no-organization", code: problem.code, problem };
  }
  return undefined;
}

const NEWER: NextStep = { command: "npx haau3@latest --version", description: "Check for a newer haau3." };

function unreachable(host: string): CliError {
  return { code: "platform-unreachable", message: `${host} did not answer. Check the connection and try again.`, next: [] };
}

export type ListResult = { kind: "ok"; list: KeyList } | SessionAnswer | { kind: "error"; error: CliError };

export async function listKeys(platformURL: string, token: AccessToken, includeRevoked: boolean): Promise<ListResult> {
  const host = new URL(platformURL).host;
  const answer = await call(`${platformURL}${CLI_API_PATH}/keys${includeRevoked ? "?include=revoked" : ""}`, { bearer: token });
  if (!answer.answered) return { kind: "error", error: unreachable(host) };
  if (answer.status === 200) {
    const list = parseKeyList(answer.body, token.reveal());
    if (list) return { kind: "ok", list };
    return { kind: "error", error: { code: "unexpected-answer", message: `${host} answered with a list of keys haau3 cannot read.`, next: [NEWER], problem: problemOf(answer) } };
  }
  const problem = problemOf(answer);
  const session = sessionAnswer(answer.status, problem);
  if (session) return session;
  if (answer.status === 404) return { kind: "error", error: signInUnavailable(platformURL, answer) };
  if (answer.status >= 500) return { kind: "error", error: platformUnavailable(host, answer) };
  return { kind: "error", error: { code: "unexpected-answer", message: `${host} refused to list the keys (HTTP ${answer.status}).`, next: [NEWER], problem } };
}

export type ReadResult =
  | { kind: "ok"; key: ListedKey }
  /** No key of the organization's has that id. */
  | { kind: "not-found"; problem: Problem }
  | SessionAnswer
  | { kind: "error"; error: CliError };

/** One of the organization's keys. `id` must already be a key's id (isKeyId): it goes in the path. */
export async function readKey(platformURL: string, token: AccessToken, id: string): Promise<ReadResult> {
  if (!isKeyId(id)) throw new Error("readKey: not a key's id");
  const host = new URL(platformURL).host;
  const answer = await call(`${platformURL}${CLI_API_PATH}/keys/${id}`, { bearer: token });
  if (!answer.answered) return { kind: "error", error: unreachable(host) };
  if (answer.status === 200) {
    const key = parseListedKey(answer.body, token.reveal());
    if (key && key.id.toLowerCase() === id.toLowerCase()) return { kind: "ok", key };
    return { kind: "error", error: { code: "unexpected-answer", message: `${host} answered with a description of the key haau3 cannot read.`, next: [NEWER], problem: problemOf(answer) } };
  }
  const problem = problemOf(answer);
  const session = sessionAnswer(answer.status, problem);
  if (session) return session;
  if (answer.status === 404 && problem.code === "key-not-found") return { kind: "not-found", problem };
  if (answer.status === 404) return { kind: "error", error: signInUnavailable(platformURL, answer) };
  if (answer.status >= 500) return { kind: "error", error: platformUnavailable(host, answer) };
  return { kind: "error", error: { code: "unexpected-answer", message: `${host} refused to describe the key (HTTP ${answer.status}).`, next: [NEWER], problem } };
}

export type RevokeResult =
  | { kind: "revoked"; key: ListedKey }
  /** Revoked before this request: `signInEnded` when the platform ended the sign-in before it found out. */
  | { kind: "already-revoked"; revokedAt: string | null; signInEnded: boolean; problem: Problem }
  | { kind: "not-found"; signInEnded: boolean; problem: Problem }
  /** One of the playground keys the dashboard keeps. */
  | { kind: "managed"; signInEnded: boolean; problem: Problem }
  | SessionAnswer
  /**
   * The key may have been revoked: the platform failed, gave no answer, or answered with a success
   * haau3 cannot read. The sign-in may have ended before it did.
   */
  | { kind: "unknown"; error: CliError }
  /** Refused, nothing revoked. The sign-in is kept unless the refusal says it ended (`signInEnded`). */
  | { kind: "error"; signInEnded: boolean; error: CliError };

/** How long the platform may take to revoke a key: it ends the sign-in first, which asks the sign-in service three times. */
export const REVOKE_TIMEOUT_MS = 30_000;

/** Revokes one of the organization's keys. `id` must already be a key's id (isKeyId): it goes in the path. */
export async function revokeKey(platformURL: string, token: AccessToken, id: string): Promise<RevokeResult> {
  if (!isKeyId(id)) throw new Error("revokeKey: not a key's id");
  const host = new URL(platformURL).host;
  const keysPage = `${platformURL}/dashboard/keys`;
  const answer = await call(`${platformURL}${CLI_API_PATH}/keys/${id}/revoke`, { bearer: token, post: true, timeoutMs: REVOKE_TIMEOUT_MS });
  if (!answer.answered) {
    return {
      kind: "unknown",
      error: { code: "platform-unreachable", message: `${host} did not answer, so the key may or may not have been revoked. Look on the keys page at ${keysPage}.`, next: [] },
    };
  }
  if (answer.status === 200) {
    const key = parseListedKey(answer.body, token.reveal());
    if (key && key.id.toLowerCase() === id.toLowerCase() && key.revokedAt !== null) return { kind: "revoked", key };
  }
  if (answer.status >= 200 && answer.status < 300) {
    return {
      kind: "unknown",
      error: {
        code: "unexpected-answer",
        message: `${host} answered in a way haau3 cannot use (HTTP ${answer.status}), and it may have revoked the key. Look on the keys page at ${keysPage}.`,
        next: [NEWER],
        problem: problemOf(answer),
      },
    };
  }
  const problem = problemOf(answer);
  const body = isRecord(answer.body) ? answer.body : {};
  const signInEnded = body.signInEnded === true;
  if (answer.status === 409 && problem.code === "already-revoked") {
    return { kind: "already-revoked", revokedAt: time(body.revokedAt) ?? null, signInEnded, problem };
  }
  if (answer.status === 409 && problem.code === "managed-key") return { kind: "managed", signInEnded, problem };
  if (answer.status === 404 && problem.code === "key-not-found") return { kind: "not-found", signInEnded, problem };
  const session = sessionAnswer(answer.status, problem);
  if (session) return session;
  if (answer.status >= 500) {
    const unavailable = platformUnavailable(host, answer);
    return { kind: "unknown", error: { ...unavailable, message: `${unavailable.message} The key may have been revoked anyway: look on the keys page at ${keysPage} before trying again.` } };
  }
  // Any other refusal revoked nothing; whether it spent the sign-in, it says (`signInEnded`), whatever its code.
  if (answer.status === 404) return { kind: "error", signInEnded, error: signInUnavailable(platformURL, answer) };
  return { kind: "error", signInEnded, error: { code: "unexpected-answer", message: `${host} refused to revoke the key (HTTP ${answer.status}).`, next: [NEWER], problem } };
}
