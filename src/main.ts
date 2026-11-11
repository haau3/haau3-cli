// Reads the arguments, picks the format and runs what was asked. Everything it prints goes through
// here, so the output contract holds for every command.
import { parseArgs } from "node:util";
import { HELP, helpText } from "./help.js";
import {
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
import { VERSION } from "./version.js";

export interface Io {
  stdout: { write(text: string): unknown; isTTY?: boolean };
  stderr: { write(text: string): unknown };
  env: NodeJS.ProcessEnv;
  cwd: string;
}

const OPTIONS = {
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean" },
} as const;

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
    write(io, chooseFormat(argv.includes("--json"), Boolean(io.stdout.isTTY), io.env), document);
    return EXIT.failed;
  }
}

export async function run(argv: string[], io: Io): Promise<ExitCode> {
  const jsonFlag = argv.includes("--json");
  const format = chooseFormat(jsonFlag, Boolean(io.stdout.isTTY), io.env);

  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch {
    return usage(io, format, flagError(argv));
  }
  const { values, positionals } = parsed;

  // --help and --version print text unless JSON was asked for: the automatic switch leaves them alone.
  const asked = askedFormat(jsonFlag, io.env) ?? "text";
  if (values.version) {
    if (asked === "json") write(io, "json", success("version", { version: VERSION }));
    else io.stdout.write(`${VERSION}\n`);
    return EXIT.ok;
  }
  const [command] = positionals;
  if (values.help || command === undefined || command === "help") {
    if (asked === "json") write(io, "json", success("help", HELP));
    else io.stdout.write(helpText());
    return EXIT.ok;
  }
  return usage(io, format, {
    code: "unknown-command",
    message: SAFE_COMMAND.test(command) ? `haau3 has no command named ${command}.` : "haau3 has no such command.",
    next: [HELP_STEP],
  });
}

function flagError(argv: string[]): CliError {
  const known = new Set(["--json", "--help", "-h", "--version", "--"]);
  const unknown = argv.find((arg) => arg.startsWith("-") && !known.has(arg) && !known.has(arg.split("=")[0]!));
  if (unknown !== undefined) {
    // The flag's name only, never a value after its `=`.
    const name = unknown.split("=")[0]!;
    return {
      code: "unknown-flag",
      message: SAFE_FLAG.test(name) ? `haau3 has no flag ${name}.` : "haau3 has no such flag.",
      next: [HELP_STEP],
    };
  }
  return { code: "invalid-flag", message: "A flag was given a value, and haau3's flags take none.", next: [HELP_STEP] };
}

function usage(io: Io, format: Format, error: CliError): ExitCode {
  write(io, format, failure(null, error));
  return EXIT.usage;
}

/** One JSON document on stdout, or text: a result on stdout, an error and its next steps on stderr. */
function write(io: Io, format: Format, document: Document): void {
  if (format === "json") {
    io.stdout.write(render(document));
    return;
  }
  if (document.error) {
    const steps = document.error.next.map((step) => `  ${step.command}\n    ${step.description}`).join("\n");
    io.stderr.write(`${document.error.message}\n${steps ? `\nNext:\n${steps}\n` : ""}`);
  }
}
