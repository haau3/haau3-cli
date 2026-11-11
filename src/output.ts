// The output contract every command keeps. Readable text at a terminal; otherwise one JSON document
// on stdout, errors included, with no prompt, spinner or colour, and a non-zero exit on failure.
import type { Environment } from "./environment.js";
import { VERSION } from "./version.js";

/**
 * The version of the document's shape, read as Terraform reads its own: a minor bump only adds
 * fields, which a reader ignores; a major bump changes or removes one, and a reader that does not
 * know that major refuses the document.
 */
export const FORMAT_VERSION = "1.0";

/** 0: it worked. 1: it ran and something failed. 2: it was used wrongly. error.code says which. */
export const EXIT = { ok: 0, failed: 1, usage: 2 } as const;
export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** A command to run next, and why. */
export interface NextStep {
  command: string;
  description: string;
}

/** The API's own RFC 9457 problem, as it answered. Never a body. */
export interface Problem {
  type: string;
  title: string;
  status: number;
  requestId?: string;
}

export interface CliError {
  /** Short and kebab-case; what to branch on. */
  code: string;
  message: string;
  next: NextStep[];
  /** Present when the API's answer is the failure. */
  problem?: Problem;
}

/** Every command prints one of these. Each field is always present; data or error is null. */
export interface Document<T = unknown> {
  formatVersion: typeof FORMAT_VERSION;
  cli: "haau3";
  cliVersion: string;
  /** The command that ran, or null when none was recognized. */
  command: string | null;
  ok: boolean;
  /** The environment a key or a call concerns, or null when the document concerns neither. */
  environment: Environment | null;
  data: T | null;
  error: CliError | null;
}

export function success<T>(command: string, data: T, environment: Environment | null = null): Document<T> {
  return { formatVersion: FORMAT_VERSION, cli: "haau3", cliVersion: VERSION, command, ok: true, environment, data, error: null };
}

export function failure(command: string | null, error: CliError, environment: Environment | null = null): Document<never> {
  return { formatVersion: FORMAT_VERSION, cli: "haau3", cliVersion: VERSION, command, ok: false, environment, data: null, error };
}

export function render(document: Document): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

export type Format = "json" | "text";

/** Asks for a format whatever the terminal: json or text. Ignored when it holds anything else. */
export const OUTPUT_VARIABLE = "HAAU3_OUTPUT";

/**
 * Codex can run a command in a pseudo-terminal, so its markers mean an agent is reading even when
 * stdout is a terminal.
 */
export const CODEX_MARKERS = ["CODEX_SANDBOX", "CODEX_THREAD_ID", "CODEX_SANDBOX_NETWORK_DISABLED", "CODEX_CI"] as const;

/** The format the caller asked for, by --json or HAAU3_OUTPUT, or null. --help and --version follow only this. */
export function askedFormat(jsonFlag: boolean, env: NodeJS.ProcessEnv): Format | null {
  if (jsonFlag) return "json";
  const asked = env[OUTPUT_VARIABLE]?.trim().toLowerCase();
  return asked === "json" || asked === "text" ? asked : null;
}

/** What a command prints: what was asked for, else JSON for an agent or a pipe, else text. */
export function chooseFormat(jsonFlag: boolean, stdoutIsTTY: boolean, env: NodeJS.ProcessEnv): Format {
  const asked = askedFormat(jsonFlag, env);
  if (asked) return asked;
  if (CODEX_MARKERS.some((name) => Boolean(env[name]))) return "json";
  return stdoutIsTTY ? "text" : "json";
}
