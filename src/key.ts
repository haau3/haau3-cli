// How the command line finds an API key: where the application will find it. The process environment
// first, then the project's env files, in the folder the command runs in. It reports facts about the
// key (where it was, its mode, the environment it reaches) and never the key.
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { inspect, parseEnv } from "node:util";
import type { Environment } from "./environment.js";

export const KEY_VARIABLE = "HAAU3_API_KEY";

/** Read in this order, after the environment: frameworks load .env.local over .env. */
export const KEY_FILES = [".env.local", ".env"] as const;

export type KeySource = "environment" | (typeof KEY_FILES)[number];

/** A key's mode, read from its prefix. A value that has neither prefix is not a haau3 key. */
export type KeyMode = "live" | "test" | "unrecognized";

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
  return "unrecognized";
}

/** A live key reaches production, a test key the Sandbox (the API's rule). */
export function environmentOf(mode: KeyMode): Environment | null {
  if (mode === "live") return "production";
  if (mode === "test") return "sandbox";
  return null;
}

/** An env file bigger than this is not one, and is not read. */
const MAX_FILE_BYTES = 1024 * 1024;

export function findKey({ cwd, env }: { cwd: string; env: NodeJS.ProcessEnv }): KeyResult {
  const fromEnvironment = env[KEY_VARIABLE];
  if (present(fromEnvironment)) return found("environment", fromEnvironment);

  for (const file of KEY_FILES) {
    const value = readVariable(join(cwd, file));
    if (present(value)) return found(file, value);
  }
  return { report: { status: "not-found", looked: ["environment", ...KEY_FILES] }, key: null };
}

export function notNeeded(environment: Environment): KeyResult {
  return { report: { status: "not-needed", environment }, key: null };
}

function present(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== "";
}

function found(source: KeySource, value: string): KeyResult {
  const mode = modeOf(value);
  return { report: { status: "found", source, mode, environment: environmentOf(mode) }, key: new ApiKey(value) };
}

/** The variable's value in one env file, read with Node's own parser (the one behind --env-file). */
function readVariable(path: string): string | undefined {
  try {
    if (statSync(path).size > MAX_FILE_BYTES) return undefined;
    return parseEnv(readFileSync(path, "utf8"))[KEY_VARIABLE];
  } catch {
    // Missing, a folder, or unreadable: the application would not find a key there either.
    return undefined;
  }
}
