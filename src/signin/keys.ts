// The platform's answer to "make a key": a new API key for the organization the session was approved
// for, made the way the dashboard makes one and marked as made from the command line. The answer
// carries the key's secret this once. It goes straight into an ApiKey, which prints as hidden, and is
// checked to be exactly a key of the mode asked for, so nothing else can ever be written to the file.
import { ApiKey } from "../key.js";
import type { CliError, Problem } from "../output.js";
import { CLI_API_PATH, platformUnavailable, signInUnavailable } from "./discovery.js";
import { call, displayText, isRecord, problemOf, text } from "./http.js";
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
  /** A key may exist: the platform made one and its answer could not be used, or no answer came. */
  | { kind: "unknown"; made: MadeKey | null; error: CliError }
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
      error: {
        code: "unexpected-answer",
        message: `${host} answered in a way haau3 cannot use (HTTP ${answer.status}), so nothing was written, and it may have made a key. Revoke any you do not recognise on the keys page at ${platformURL}/dashboard/keys.`,
        next: [{ command: "npx haau3@latest --version", description: "Check for a newer haau3." }],
      },
    };
  }
  const problem = problemOf(answer);
  if (answer.status === 401) return { kind: "ended", problem };
  if (answer.status === 403 && (problem.code === "not-a-member" || problem.code === "no-organization")) {
    return { kind: "no-organization", code: problem.code, problem };
  }
  if (answer.status === 404) return { kind: "error", error: { ...signInUnavailable(platformURL), problem } };
  if (answer.status >= 500) {
    // The platform bounds how long it waits for the database without stopping the write, so an error
    // can come back for a key that was made. Trying again without looking would make a second one.
    const unavailable = platformUnavailable(host, answer);
    return {
      kind: "unknown",
      made: null,
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
  const random = secret.replace(/^haau3_sk_(?:live|test)_/, "");
  for (let i = 0; i + 8 <= random.length; i++) if (value.includes(random.slice(i, i + 8))) return true;
  return false;
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
