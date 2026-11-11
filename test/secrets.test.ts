// An API key is never printed. Made-up keys are planted where the command line looks (the environment
// and both env files) beside another secret it must never read out, then every command runs, in this
// process and as a real process, and nothing it prints may hold any of them. A new command joins
// COMMANDS the day it is added. The controls prove the check catches a leak and the keys are planted.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { format, inspect } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findKey } from "../src/key.js";
import { runCli, spawnCli } from "./helpers.js";

// Built from parts, so no file in this repository holds a whole key-shaped string.
const CORE = ["PLANTED", "KEY", "7f3a9c"].join("");
const IN_ENVIRONMENT = ["haau3", "sk", "live", `${CORE}env`].join("_");
const IN_ENV_LOCAL = ["haau3", "sk", "test", `${CORE}local`].join("_");
const IN_ENV = ["haau3", "sk", "live", `${CORE}dotenv`].join("_");
const NEIGHBOUR = ["PLANTED", "NEIGHBOUR", "e41b07"].join("");
const PLANTED = [IN_ENVIRONMENT, IN_ENV_LOCAL, IN_ENV, CORE, NEIGHBOUR];

/** Throws, without repeating it, when `text` holds anything planted. */
function assertClean(text: string, where: string): void {
  const hit = PLANTED.findIndex((planted) => text.includes(planted));
  if (hit !== -1) throw new Error(`${where} shows planted secret number ${hit}`);
}

/**
 * Every argument list 0.1 accepts or refuses, and the planted key typed where a command or a flag
 * would be. Each has a label, so no test's name holds a key-shaped string.
 */
const COMMANDS: [string, string[]][] = [
  ["no arguments", []],
  ["--help", ["--help"]],
  ["-h", ["-h"]],
  ["help", ["help"]],
  ["--version", ["--version"]],
  ["--json", ["--json"]],
  ["--json --help", ["--json", "--help"]],
  ["--json --version", ["--json", "--version"]],
  ["an unknown command", ["no-such-command"]],
  ["an unknown flag", ["--no-such-flag"]],
  ["a value for --json", ["--json=1"]],
  ["the key as a command", [IN_ENVIRONMENT]],
  ["the key as a flag", [`--${IN_ENVIRONMENT}`]],
  ["the key as --json's value", [`--json=${IN_ENVIRONMENT}`]],
  ["the key as an unknown flag's value", [`--key=${IN_ENVIRONMENT}`]],
  ["the key after help", ["help", IN_ENVIRONMENT]],
  ["the key after --", ["--", IN_ENVIRONMENT]],
];

let project: string;
beforeAll(() => {
  project = mkdtempSync(join(tmpdir(), "cli-secrets-"));
  writeFileSync(join(project, ".env.local"), `NEIGHBOUR_TOKEN=${NEIGHBOUR}\nHAAU3_API_KEY=${IN_ENV_LOCAL}\n`);
  writeFileSync(join(project, ".env"), `HAAU3_API_KEY=${IN_ENV}\nNEIGHBOUR_TOKEN=${NEIGHBOUR}\n`);
});
afterAll(() => rmSync(project, { recursive: true, force: true }));

describe("the controls", () => {
  it("catch a planted secret, and whatever util.inspect shows of one", () => {
    expect(() => assertClean(`using ${IN_ENV_LOCAL}`, "a leaky line")).toThrow("a leaky line shows planted secret number 1");
    expect(() => assertClean(inspect({ token: NEIGHBOUR }), "an inspected object")).toThrow();
    expect(() => assertClean(`prefix ${CORE}... truncated`, "a truncated key")).toThrow();
    expect(() => assertClean("nothing here", "a clean line")).not.toThrow();
  });

  it("are planted where the command line looks", () => {
    expect(findKey({ cwd: project, env: { HAAU3_API_KEY: IN_ENVIRONMENT } }).key?.reveal()).toBe(IN_ENVIRONMENT);
    expect(findKey({ cwd: project, env: {} }).key?.reveal()).toBe(IN_ENV_LOCAL);
  });
});

describe("no command prints a planted secret", () => {
  for (const [label, args] of COMMANDS) {
    it(`${label}, at a terminal and not, as text and as JSON`, async () => {
      for (const tty of [true, false]) {
        for (const output of ["", "json", "text"]) {
          const env = { HAAU3_API_KEY: IN_ENVIRONMENT, NEIGHBOUR_TOKEN: NEIGHBOUR, HAAU3_OUTPUT: output };
          const out = await runCli(args, { tty, env, cwd: project });
          assertClean(out.stdout, "stdout");
          assertClean(out.stderr, "stderr");
        }
      }
    });
  }

  it("as a real process, whose stdout is a pipe", () => {
    const labels = ["no arguments", "--version", "--json --help", "an unknown command", "the key as a command", "the key as --json's value"];
    for (const [label, args] of COMMANDS.filter(([l]) => labels.includes(l))) {
      const out = spawnCli(args, { cwd: project, env: { HAAU3_API_KEY: IN_ENVIRONMENT, NEIGHBOUR_TOKEN: NEIGHBOUR } });
      expect(out.code === 0 || out.code === 2, label).toBe(true);
      assertClean(out.stdout, `stdout of ${label}`);
      assertClean(out.stderr, `stderr of ${label}`);
    }
  });
});

describe("a found key prints as hidden however it is printed", () => {
  for (const [where, env] of [
    ["the environment", { HAAU3_API_KEY: IN_ENVIRONMENT }],
    ["an env file", {}],
  ] as const) {
    it(`from ${where}`, () => {
      const result = findKey({ cwd: project, env });
      const key = result.key!;
      const shown = [
        JSON.stringify(result),
        JSON.stringify(result.report),
        inspect(result, { depth: Infinity, showHidden: true }),
        format("%s %o %O %j %d", key, key, result, result, key),
        String(key),
        `${key}`,
        key + "",
        new Error(`the call with ${key} failed`).message,
        JSON.stringify({ ...key }),
        JSON.stringify(Object.entries(key)),
        inspect(structuredClone({ report: result.report })),
      ];
      for (const [i, text] of shown.entries()) assertClean(text, `printing number ${i}`);
      expect(String(key)).toBe("[haau3 key hidden]");
      expect(inspect(key)).toBe("[haau3 key hidden]");
      expect(JSON.stringify(key)).toBe('"[haau3 key hidden]"');
    });
  }
});
