// Reads the arguments, picks the format and runs what was asked. Everything it prints goes through
// here, so the output contract holds for every command.
import { parseArgs, type ParseArgsOptionsConfig } from "node:util";
import { doctor } from "./commands/doctor.js";
import { keysCreate } from "./commands/keys.js";
import { login } from "./commands/login.js";
import { logout } from "./commands/logout.js";
import { test } from "./commands/test.js";
import { whoami } from "./commands/whoami.js";
import { init } from "./commands/init.js";
import type { Ask, Context, Result } from "./commands/context.js";
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
  openBrowser?: (url: string) => Promise<boolean>;
  /** The fetch the API's client sends with. The global one by default. */
  fetch?: typeof fetch;
  /** Asks a person at a terminal to pick. Only used when a person is at a terminal. */
  ask?: Ask;
}

const GLOBAL_OPTIONS = {
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean" },
} as const satisfies ParseArgsOptionsConfig;

interface Command {
  options: ParseArgsOptionsConfig;
  /** How many arguments it takes after its name: none unless it says. */
  takes?: number;
  run(ctx: Context, values: Record<string, unknown>, args: string[]): Promise<Result>;
}

/** A command named by two words, such as `keys create`: the second word picks it. */
interface Group {
  sub: Map<string, Command>;
}

const stringValue = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

const KEYS = new Map<string, Command>([
  [
    "create",
    {
      // Not --env-file: Node takes that flag as its own wherever it appears, even after the script, and
      // would load the file or print its name before this code runs.
      options: { test: { type: "boolean" }, replace: { type: "boolean" }, name: { type: "string" }, file: { type: "string" } },
      run: (ctx, values) =>
        keysCreate(ctx, { test: values.test === true, replace: values.replace === true, name: stringValue(values.name), file: stringValue(values.file) }),
    },
  ],
]);

/** Every command, by name. A Map, so no name typed by mistake can reach an object's own properties. */
const COMMANDS = new Map<string, Command | Group>([
  ["login", { options: { complete: { type: "boolean" } }, run: (ctx, values) => login(ctx, { complete: values.complete === true }) }],
  ["whoami", { options: {}, run: (ctx) => whoami(ctx) }],
  ["logout", { options: {}, run: (ctx) => logout(ctx) }],
  ["keys", { sub: KEYS }],
  // --file as doctor's; every choice init cannot make from the project's files is one of these flags.
  [
    "init",
    {
      options: {
        language: { type: "string" },
        "package-manager": { type: "string" },
        agent: { type: "string", multiple: true },
        "no-agent": { type: "boolean" },
        file: { type: "string" },
      },
      run: (ctx, values) =>
        init(ctx, {
          language: stringValue(values.language),
          packageManager: stringValue(values["package-manager"]),
          agents: Array.isArray(values.agent) ? values.agent.filter((a): a is string => typeof a === "string") : [],
          noAgent: values["no-agent"] === true,
          file: stringValue(values.file),
        }),
    },
  ],
  // --file, not --env-file, for the reason keys create gives.
  ["doctor", { options: { file: { type: "string" } }, run: (ctx, values) => doctor(ctx, { file: stringValue(values.file) }) }],
  // One argument, the service; --file as doctor's.
  [
    "test",
    {
      options: { all: { type: "boolean" }, file: { type: "string" } },
      takes: 1,
      run: (ctx, values, args) => test(ctx, { service: args[0], all: values.all === true, file: stringValue(values.file) }),
    },
  ],
]);

/** The options a command or a group takes: a group takes every one its commands do. */
function optionsOf(entry: Command | Group | undefined): ParseArgsOptionsConfig {
  if (!entry) return {};
  if ("sub" in entry) return Object.assign({}, ...[...entry.sub.values()].map((c) => c.options)) as ParseArgsOptionsConfig;
  return entry.options;
}

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

  // The command is the first word that names one, else the first that is not a flag. A command's flag
  // can take a value, and given before the command its value comes first (--name x keys create), so
  // the first word is not always the command. Once parsed, the command must be the first positional,
  // or a flag's value took its word; either way nothing but a command's name is repeated back.
  const words = argv.slice(0, argv.includes("--") ? argv.indexOf("--") : argv.length).filter((arg) => !arg.startsWith("-"));
  const name = words.find((word) => COMMANDS.has(word)) ?? words[0];
  const entry = name === undefined ? undefined : COMMANDS.get(name);
  const options: ParseArgsOptionsConfig = { ...GLOBAL_OPTIONS, ...optionsOf(entry) };

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
  if (!entry || first !== name) {
    return usage(io, format, {
      code: "unknown-command",
      message: SAFE_COMMAND.test(first) ? `haau3 has no command named ${first}.` : "haau3 has no such command.",
      next: [HELP_STEP],
    });
  }
  let command: Command;
  let label = first;
  if ("sub" in entry) {
    const second = positionals[1];
    const sub = second === undefined ? undefined : entry.sub.get(second);
    if (!sub) {
      const names = [...entry.sub.keys()].map((k) => `${first} ${k}`).join(", ");
      const message =
        second === undefined
          ? `haau3 ${first} needs a command: ${names}.`
          : SAFE_COMMAND.test(second)
            ? `haau3 ${first} has no command named ${second}. It has ${names}.`
            : `haau3 ${first} has no such command. It has ${names}.`;
      return usage(io, format, { code: second === undefined ? "missing-command" : "unknown-command", message, next: [HELP_STEP] }, first);
    }
    command = sub;
    label = `${first} ${second}`;
  } else {
    command = entry;
  }
  // A flag another command takes, given to this one, is unknown here.
  for (const flag of Object.keys(values)) {
    if (!(flag in GLOBAL_OPTIONS) && !(flag in command.options)) {
      return usage(io, format, { code: "unknown-flag", message: `haau3 ${label} has no flag --${flag}.`, next: [HELP_STEP] }, label);
    }
  }
  const named = label.split(" ").length;
  const takes = command.takes ?? 0;
  if (positionals.length > named + takes) {
    // The extra argument is never repeated back: it may be anything, a key included.
    const message = takes === 0 ? `haau3 ${label} takes no arguments.` : `haau3 ${label} takes ${takes === 1 ? "one argument" : `${takes} arguments`}.`;
    return usage(io, format, { code: "unexpected-argument", message, next: [HELP_STEP] }, label);
  }

  const ctx = context(io, format);
  const result = await command.run(ctx, values, positionals.slice(named));
  write(io, format, result.document, result.text);
  return result.exit;
}

function context(io: Io, format: Format): Context {
  const interactive = format === "text" && Boolean(io.stdout.isTTY) && Boolean(io.stdin?.isTTY) && !agentDetected(io.env);
  return {
    format,
    interactive,
    env: io.env,
    cwd: io.cwd,
    store: io.store ?? sessionStore({ env: io.env }),
    now: io.now ?? Date.now,
    sleep: io.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    say: (text) => {
      if (format === "text") io.stdout.write(text);
    },
    enter: interactive ? io.enter : undefined,
    openBrowser: interactive ? io.openBrowser : undefined,
    ask: interactive ? io.ask : undefined,
    fetch: io.fetch,
  };
}

/** Why parseArgs refused: a flag's name is repeated back, never a value given to it. */
function flagError(argv: string[], options: ParseArgsOptionsConfig): CliError {
  const known = new Map<string, ParseArgsOptionsConfig[string]>();
  for (const [long, option] of Object.entries(options)) {
    known.set(`--${long}`, option);
    if (option.short) known.set(`-${option.short}`, option);
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") break;
    if (!arg.startsWith("-")) continue;
    const flag = arg.split("=")[0]!;
    const option = known.get(flag);
    if (!option) {
      return {
        code: "unknown-flag",
        message: SAFE_FLAG.test(flag) ? `haau3 has no flag ${flag}.` : "haau3 has no such flag.",
        next: [HELP_STEP],
      };
    }
    if (option.type === "boolean" && arg.includes("=")) {
      return { code: "invalid-flag", message: `${flag} takes no value.`, next: [HELP_STEP] };
    }
    if (option.type === "string" && !arg.includes("=")) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("-")) {
        return { code: "missing-value", message: `${flag} needs a value: ${flag} <value>, or ${flag}=<value> for one that starts with a dash.`, next: [HELP_STEP] };
      }
      i++;
    }
  }
  return { code: "invalid-flag", message: "A flag was used in a way haau3 does not take.", next: [HELP_STEP] };
}

function usage(io: Io, format: Format, error: CliError, command: string | null = null): ExitCode {
  write(io, format, failure(command, error), "");
  return EXIT.usage;
}

/**
 * One JSON document on stdout, or text: a result's text on stdout, an error and its next steps on
 * stderr. A failure has text only when its command reports what it found either way (doctor).
 */
function write(io: Io, format: Format, document: Document, text: string): void {
  if (format === "json") {
    io.stdout.write(render(document));
    return;
  }
  if (text) io.stdout.write(text);
  if (document.error) {
    const steps = document.error.next.map((step) => `  ${step.command}\n    ${step.description}`).join("\n");
    io.stderr.write(`${document.error.message}\n${steps ? `\nNext:\n${steps}\n` : ""}`);
  }
}
