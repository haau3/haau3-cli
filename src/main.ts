// Reads the arguments, picks the format and runs what was asked. Everything it prints goes through
// here, so the output contract holds for every command.
import { parseArgs, type ParseArgsOptionsConfig } from "node:util";
import { login } from "./commands/login.js";
import { logout } from "./commands/logout.js";
import { whoami } from "./commands/whoami.js";
import type { Context, Result } from "./commands/context.js";
import { HELP, helpText } from "./help.js";
import {
  agentDetected,
  askedFormat,
  chooseFormat,
  EXIT,
  failure,
  render,
  success,
  type CliError,
  type Document,
  type ExitCode,
  type Format,
} from "./output.js";
import { sessionStore, type SessionStore } from "./session/store.js";
import { VERSION } from "./version.js";

export interface Io {
  stdout: { write(text: string): unknown; isTTY?: boolean };
  stderr: { write(text: string): unknown };
  /** Absent means not a terminal: nothing is asked of it. */
  stdin?: { isTTY?: boolean };
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** The clock, in milliseconds since the epoch. Date.now by default. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Where a session is kept. The operating system's store, then the file, by default. */
  store?: SessionStore;
  /** Listens for Enter on stdin. Only used when a person is at a terminal. */
  enter?: () => { pressed: Promise<void>; stop(): void };
  openBrowser?: (url: string) => boolean;
}

const GLOBAL_OPTIONS = {
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean" },
} as const satisfies ParseArgsOptionsConfig;

interface Command {
  options: ParseArgsOptionsConfig;
  run(ctx: Context, values: Record<string, unknown>): Promise<Result>;
}

/** Every command, by name. A Map, so no name typed by mistake can reach an object's own properties. */
const COMMANDS = new Map<string, Command>([
  ["login", { options: { complete: { type: "boolean" } }, run: (ctx, values) => login(ctx, { complete: values.complete === true }) }],
  ["whoami", { options: {}, run: (ctx) => whoami(ctx) }],
  ["logout", { options: {}, run: (ctx) => logout(ctx) }],
]);

const HELP_STEP = { command: "npx haau3 --help", description: "See what haau3 can do." };

/** A name safe to repeat back: it cannot be a key, a path or anything else someone typed by mistake. */
const SAFE_COMMAND = /^[a-z][a-z0-9-]{0,40}$/;
const SAFE_FLAG = /^--?[A-Za-z][A-Za-z0-9-]{0,40}$/;

/** Runs the command line and returns its exit code. An error of its own is reported, never thrown. */
export async function main(argv: string[], io: Io): Promise<ExitCode> {
  try {
    return await run(argv, io);
  } catch (error) {
    // Only the error's name: a message can repeat whatever the failing code was holding.
    const name = error instanceof Error ? error.name : "a value that is not an Error";
    const document = failure(null, {
      code: "internal-error",
      message: `haau3 stopped on an error of its own (${name}).`,
      next: [{ command: "npx haau3@latest --version", description: "Check for a newer version, then report it at https://github.com/haau3/haau3-cli/issues." }],
    });
    write(io, chooseFormat(argv.includes("--json"), Boolean(io.stdout.isTTY), io.env), document, "");
    return EXIT.failed;
  }
}

export async function run(argv: string[], io: Io): Promise<ExitCode> {
  const jsonFlag = argv.includes("--json");
  const format = chooseFormat(jsonFlag, Boolean(io.stdout.isTTY), io.env);

  // The command is the first argument that is not a flag. No global flag takes a value, so nothing
  // before it can be one.
  const name = argv.slice(0, argv.includes("--") ? argv.indexOf("--") : argv.length).find((arg) => !arg.startsWith("-"));
  const command = name === undefined ? undefined : COMMANDS.get(name);
  const options: ParseArgsOptionsConfig = { ...GLOBAL_OPTIONS, ...command?.options };

  let parsed;
  try {
    parsed = parseArgs({ args: argv, options, allowPositionals: true, strict: true });
  } catch {
    return usage(io, format, flagError(argv, options));
  }
  const { values, positionals } = parsed;

  // --help and --version print text unless JSON was asked for: the automatic switch leaves them alone.
  const asked = askedFormat(jsonFlag, io.env) ?? "text";
  if (values.version) {
    if (asked === "json") write(io, "json", success("version", { version: VERSION }), "");
    else io.stdout.write(`${VERSION}\n`);
    return EXIT.ok;
  }
  const [first] = positionals;
  if (values.help || first === undefined || first === "help") {
    if (asked === "json") write(io, "json", success("help", HELP), "");
    else io.stdout.write(helpText());
    return EXIT.ok;
  }
  if (!command) {
    return usage(io, format, {
      code: "unknown-command",
      message: SAFE_COMMAND.test(first) ? `haau3 has no command named ${first}.` : "haau3 has no such command.",
      next: [HELP_STEP],
    });
  }
  if (positionals.length > 1) {
    // The extra argument is never repeated back: it may be anything, a key included.
    return usage(io, format, { code: "unexpected-argument", message: `haau3 ${first} takes no arguments.`, next: [HELP_STEP] }, first);
  }

  const ctx = context(io, format);
  const result = await command.run(ctx, values);
  write(io, format, result.document, result.text);
  return result.exit;
}

function context(io: Io, format: Format): Context {
  const interactive = format === "text" && Boolean(io.stdout.isTTY) && Boolean(io.stdin?.isTTY) && !agentDetected(io.env);
  return {
    format,
    interactive,
    env: io.env,
    store: io.store ?? sessionStore({ env: io.env }),
    now: io.now ?? Date.now,
    sleep: io.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    say: (text) => {
      if (format === "text") io.stdout.write(text);
    },
    enter: interactive ? io.enter : undefined,
    openBrowser: interactive ? io.openBrowser : undefined,
  };
}

function flagError(argv: string[], options: ParseArgsOptionsConfig): CliError {
  const known = new Set(["--"]);
  for (const [long, option] of Object.entries(options)) {
    known.add(`--${long}`);
    if (option.short) known.add(`-${option.short}`);
  }
  const unknown = argv.find((arg) => arg.startsWith("-") && !known.has(arg) && !known.has(arg.split("=")[0]!));
  if (unknown !== undefined) {
    // The flag's name only, never a value after its `=`.
    const flag = unknown.split("=")[0]!;
    return {
      code: "unknown-flag",
      message: SAFE_FLAG.test(flag) ? `haau3 has no flag ${flag}.` : "haau3 has no such flag.",
      next: [HELP_STEP],
    };
  }
  return { code: "invalid-flag", message: "A flag was given a value, and haau3's flags take none.", next: [HELP_STEP] };
}

function usage(io: Io, format: Format, error: CliError, command: string | null = null): ExitCode {
  write(io, format, failure(command, error), "");
  return EXIT.usage;
}

/**
 * One JSON document on stdout, or text: a result's text on stdout, an error and its next steps on
 * stderr.
 */
function write(io: Io, format: Format, document: Document, text: string): void {
  if (format === "json") {
    io.stdout.write(render(document));
    return;
  }
  if (document.error) {
    const steps = document.error.next.map((step) => `  ${step.command}\n    ${step.description}`).join("\n");
    io.stderr.write(`${document.error.message}\n${steps ? `\nNext:\n${steps}\n` : ""}`);
    return;
  }
  if (text) io.stdout.write(text);
}
