// How the command line finds an API key: where the application will find it. The process environment
// first, then the project's env files, in the folder the command runs in. It reports facts about the
// key (where it was, its mode, the environment it reaches) and never the key.
import { inspect } from "node:util";
import type { Environment } from "./environment.js";
import { KEY_VARIABLE, lookup, readEnvFiles } from "./settings.js";

export { KEY_VARIABLE } from "./settings.js";

/** Read in this order, after the environment: frameworks load .env.local over .env. */
export { ENV_FILES as KEY_FILES } from "./settings.js";

/** Where a key was found: the environment, or an env file as it is printed (`.env.local`, `prod.env`). */
export type KeySource = string;

/**
 * A key's mode, read from its prefix: live, test, or `older` for a key made before modes
 * (`haau3_sk_` with neither), which reaches production. A value without `haau3_sk_` is not a haau3 key.
 */
export type KeyMode = "live" | "test" | "older" | "unrecognized";

/**
 * What the command line says about a key. `not-needed` is for a call that takes no key, so a command
 * reports it the same way as the other two.
 */
export type KeyReport =
  | { status: "found"; source: KeySource; mode: KeyMode; environment: Environment | null }
  | { status: "not-found"; looked: KeySource[] }
  | { status: "not-needed"; environment: Environment };

export interface KeyResult {
  report: KeyReport;
  /** The key, for the call that sends it, or null. */
  key: ApiKey | null;
}

const HIDDEN = "[haau3 key hidden]";

/**
 * A key's value, held where nothing prints it: a string, a template, JSON, util.inspect, console.log
 * and an error's message all show HIDDEN. Only reveal() returns the value, for the request that sends
 * it.
 */
export class ApiKey {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return HIDDEN;
  }

  toJSON(): string {
    return HIDDEN;
  }

  [Symbol.toPrimitive](): string {
    return HIDDEN;
  }

  [inspect.custom](): string {
    return HIDDEN;
  }
}

export function modeOf(value: string): KeyMode {
  if (value.startsWith("haau3_sk_live_")) return "live";
  if (value.startsWith("haau3_sk_test_")) return "test";
  if (value.startsWith("haau3_sk_")) return "older";
  return "unrecognized";
}

/**
 * A haau3 key's whole shape: its prefix and 43 base64url characters (32 random bytes). A key of
 * another length was cut short or carries something more, such as a quote an env file kept.
 */
const KEY_SHAPE = /^haau3_sk_(?:live_|test_)?[A-Za-z0-9_-]{43}$/;

export function wellFormed(value: string): boolean {
  return KEY_SHAPE.test(value);
}

/** A live key, or one made before modes, reaches production, and a test key the Sandbox (the API's rule). */
export function environmentOf(mode: KeyMode): Environment | null {
  if (mode === "live" || mode === "older") return "production";
  if (mode === "test") return "sandbox";
  return null;
}

/**
 * The key, from the environment, else the first env file that sets it: `.env.local` then `.env`, or
 * the one file named instead.
 */
export function findKey({ cwd, env, file }: { cwd: string; env: NodeJS.ProcessEnv; file?: string }): KeyResult {
  const files = readEnvFiles({ cwd, file });
  const hit = lookup(KEY_VARIABLE, env, files);
  if (hit) return found(hit.source, hit.value);
  return { report: { status: "not-found", looked: ["environment", ...files.filter((f) => f.loaded).map((f) => f.shown)] }, key: null };
}

export function notNeeded(environment: Environment): KeyResult {
  return { report: { status: "not-needed", environment }, key: null };
}

function found(source: KeySource, value: string): KeyResult {
  const mode = modeOf(value);
  return { report: { status: "found", source, mode, environment: environmentOf(mode) }, key: new ApiKey(value) };
}
