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
    const made = madeKey(answer.body);
    return {
      kind: "unknown",
      made,
      error: {
        code: "unexpected-answer",
        message: `${host} made a key but answered in a way haau3 cannot use, so nothing was written. Revoke it on the keys page at ${platformURL}/dashboard/keys.`,
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
  if (answer.status >= 500) return { kind: "error", error: platformUnavailable(host, answer) };
  return {
    kind: "error",
    error: { code: "unexpected-answer", message: `${host} refused to make the key (HTTP ${answer.status}).`, next: [{ command: "npx haau3@latest --version", description: "Check for a newer haau3." }], problem },
  };
}

/** The 201, or undefined unless it holds exactly a key of the mode asked for and the facts about it. */
export function parseCreated(body: unknown, mode: KeyMode): CreatedKey | undefined {
  if (!isRecord(body)) return undefined;
  const id = text(body.id, 200);
  const name = displayText(body.name, 200);
  const prefix = text(body.keyPrefix, 100);
  const secret = body.secret;
  const start = `haau3_sk_${mode}_`;
  if (!id || !name || !prefix || body.mode !== mode || typeof secret !== "string") return undefined;
  if (!secret.startsWith(start) || !KEY_RANDOM.test(secret.slice(start.length))) return undefined;
  if (!prefix.startsWith(start) || prefix.length <= start.length || prefix.length >= secret.length || !secret.startsWith(prefix)) return undefined;
  return { id, name, prefix, mode, secret: new ApiKey(secret) };
}

/** What can be said of a key from an answer that could not be used: never its secret. */
function madeKey(body: unknown): MadeKey | null {
  if (!isRecord(body)) return null;
  const prefix = text(body.keyPrefix, 100);
  return {
    id: text(body.id, 200) ?? null,
    name: displayText(body.name, 200) ?? null,
    // A prefix is named only when it is short enough to be one, so a whole key is never repeated.
    prefix: prefix && /^haau3_sk_(?:live|test)_[A-Za-z0-9_-]{1,12}$/.test(prefix) ? prefix : null,
  };
}
