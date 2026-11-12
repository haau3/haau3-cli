// What a command is given and what it gives back, so main.ts prints every command the same way.
import type { Environment } from "../environment.js";
import { EXIT, failure, success, type CliError, type Document, type ExitCode, type Format, type NextStep } from "../output.js";
import type { SessionStore, Where } from "../session/store.js";

export interface Context {
  format: Format;
  /** A person at a terminal: stdin and stdout are terminals, text is printed and no agent is running. */
  interactive: boolean;
  env: NodeJS.ProcessEnv;
  /** The folder the command runs in: the project, for a command that reads or writes its files. */
  cwd: string;
  store: SessionStore;
  now(): number;
  sleep(ms: number): Promise<void>;
  /** Prints progress to a person at a terminal; prints nothing anywhere else. */
  say(text: string): void;
  /** Resolves when the person presses Enter; stop() stops listening. Absent where nobody can. */
  enter?: () => { pressed: Promise<void>; stop(): void };
  /** Opens a page in the browser. False when it could not. */
  openBrowser?: (url: string) => Promise<boolean>;
  /** The fetch the API's client sends with. The global one by default; tests give a stand-in. */
  fetch?: typeof fetch;
}

export interface Result {
  document: Document;
  /** What a person at a terminal reads when it worked. A failure prints its error instead. */
  text: string;
  exit: ExitCode;
}

export function done(command: string, data: unknown, text: string, environment: Environment | null = null): Result {
  return { document: success(command, data, environment), text, exit: EXIT.ok };
}

export function failed(command: string, error: CliError, environment: Environment | null = null): Result {
  return { document: failure(command, error, environment), text: "", exit: EXIT.failed };
}

export function misused(command: string, error: CliError, environment: Environment | null = null): Result {
  return { document: failure(command, error, environment), text: "", exit: EXIT.usage };
}

/** The "Next:" block a person reads, from the same steps the document carries. */
export function nextText(steps: NextStep[]): string {
  if (steps.length === 0) return "";
  return `\nNext:\n${steps.map((step) => `  ${step.command}\n    ${step.description}`).join("\n")}\n`;
}

/** "14:32, in 41 minutes", in the computer's own time zone and clock style; just "14:32" when it has passed. */
export function when(at: number, now: number): string {
  const clock = new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (at <= now) return clock;
  const minutes = Math.round((at - now) / 60_000);
  if (minutes <= 0) return `${clock}, in less than a minute`;
  return `${clock}, in ${minutes === 1 ? "1 minute" : `${minutes} minutes`}`;
}

/** Where the session is kept, said the way a person reads it. */
export function storeSentence(where: Where): string {
  if (where.kind === "keyring") return `It is kept in ${where.name}.`;
  if (where.reason === "unreachable") return `It is kept in a file only you can read, since the system's credential store could not be reached:\n  ${where.path}`;
  if (where.reason === "asked") return `It is kept in a file only you can read, as HAAU3_SESSION_STORE asks:\n  ${where.path}`;
  return `It is kept in a file only you can read:\n  ${where.path}`;
}

/** Where the session is kept, as the document carries it. */
export function storeData(where: Where): { store: Where["kind"]; storeName: string; storePath: string | null } {
  return { store: where.kind, storeName: where.name, storePath: where.path };
}

export const LOGIN_STEP: NextStep = { command: "npx haau3 login", description: "Sign in: approve this computer in the browser." };
export const COMPLETE_STEP: NextStep = {
  command: "npx haau3 login --complete",
  description: "Wait for the approval and finish signing in. If it says the approval is still pending, run it again.",
};
export const WHOAMI_STEP: NextStep = { command: "npx haau3 whoami", description: "See who is signed in, the plan and this month's use." };
export const KEYS_CREATE_STEP: NextStep = {
  command: "npx haau3 keys create",
  description: "Make an API key and write it to this project's env file, never showing it. Add --test for a test key.",
};
/**
 * A path as a shell takes it, to put in a command someone, or an agent, will run: as it is when it
 * holds only characters no shell reads, else in single quotes, inside which neither a POSIX shell nor
 * PowerShell expands anything. A quote inside is closed and reopened as each shell spells it.
 */
export function arg(path: string, platform: NodeJS.Platform = process.platform): string {
  // A POSIX shell reads a backslash and a leading ~; on Windows a backslash separates folders.
  const plain = platform === "win32" ? /^[A-Za-z0-9._/\\:@+~-]+$/ : /^[A-Za-z0-9._/:@+-][A-Za-z0-9._/:@+~-]*$/;
  if (plain.test(path)) return path;
  return platform === "win32" ? `'${path.replaceAll("'", "''")}'` : `'${path.replaceAll("'", `'\\''`)}'`;
}

/** `--file` with its value, as one word when the value starts with a dash, which would read as a flag. */
export function fileFlag(file: string): string {
  return file.startsWith("-") ? `--file=${arg(file)}` : `--file ${arg(file)}`;
}

/** A command that reruns keys create with the same file, for a key that has to be made again. */
export function keysCreateStep(options: { test?: boolean; replace?: boolean; file?: string | undefined }, description: string): NextStep {
  const parts = ["npx haau3 keys create"];
  if (options.test) parts.push("--test");
  if (options.file !== undefined) parts.push(fileFlag(options.file));
  if (options.replace) parts.push("--replace");
  return { command: parts.join(" "), description };
}

/** Setting the Sandbox as the environment, in this shell's own words. */
export function sandboxStep(platform: NodeJS.Platform): NextStep {
  return {
    command: platform === "win32" ? `$env:HAAU3_ENVIRONMENT = "sandbox"` : `export HAAU3_ENVIRONMENT=sandbox`,
    description: `Or call the Sandbox with no key: set HAAU3_ENVIRONMENT=sandbox where the app reads its settings, such as its env file.`,
  };
}

/** `doctor`, with the env file it should read when it is not one of the defaults. */
export function doctorStep(file?: string): NextStep {
  return {
    command: file === undefined ? "npx haau3 doctor" : `npx haau3 doctor ${fileFlag(file)}`,
    description: "Check that this project is ready to call the API: the key, its environment, and a call that proves it works.",
  };
}
export const LOGOUT_STEP: NextStep = { command: "npx haau3 logout", description: "Sign out, then sign in again to pick another organization." };

/** Neither store would keep the session. */
export function storeFailed(path: string): CliError {
  return {
    code: "store-failed",
    message: `haau3 could not keep the session: neither the system's credential store nor the file at ${path} would take it. Set HAAU3_CONFIG_DIR to a folder you can write to.`,
    next: [LOGIN_STEP],
  };
}
