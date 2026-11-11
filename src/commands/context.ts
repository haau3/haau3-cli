// What a command is given and what it gives back, so main.ts prints every command the same way.
import { EXIT, failure, success, type CliError, type Document, type ExitCode, type Format, type NextStep } from "../output.js";
import type { SessionStore, Where } from "../session/store.js";

export interface Context {
  format: Format;
  /** A person at a terminal: stdin and stdout are terminals, text is printed and no agent is running. */
  interactive: boolean;
  env: NodeJS.ProcessEnv;
  store: SessionStore;
  now(): number;
  sleep(ms: number): Promise<void>;
  /** Prints progress to a person at a terminal; prints nothing anywhere else. */
  say(text: string): void;
  /** Resolves when the person presses Enter; stop() stops listening. Absent where nobody can. */
  enter?: () => { pressed: Promise<void>; stop(): void };
  /** Opens a page in the browser. False when it could not. */
  openBrowser?: (url: string) => Promise<boolean>;
}

export interface Result {
  document: Document;
  /** What a person at a terminal reads when it worked. A failure prints its error instead. */
  text: string;
  exit: ExitCode;
}

export function done(command: string, data: unknown, text: string): Result {
  return { document: success(command, data), text, exit: EXIT.ok };
}

export function failed(command: string, error: CliError): Result {
  return { document: failure(command, error), text: "", exit: EXIT.failed };
}

export function misused(command: string, error: CliError): Result {
  return { document: failure(command, error), text: "", exit: EXIT.usage };
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
export const LOGOUT_STEP: NextStep = { command: "npx haau3 logout", description: "Sign out, then sign in again to pick another organization." };

/** Neither store would keep the session. */
export function storeFailed(path: string): CliError {
  return {
    code: "store-failed",
    message: `haau3 could not keep the session: neither the system's credential store nor the file at ${path} would take it. Set HAAU3_CONFIG_DIR to a folder you can write to.`,
    next: [LOGIN_STEP],
  };
}
