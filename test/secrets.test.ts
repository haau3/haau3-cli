// No secret is ever printed: not an API key, an access token, a refresh token or a device code.
// Made-up keys are planted where the command line looks (the environment and both env files) beside
// another secret it must never read out, and a stand-in sign-in service hands out planted tokens and a
// planted device code. Then every command runs, in this process and as a real process, at a terminal
// and not, as text and as JSON, through every answer, and nothing it prints may hold any of them. A
// new command joins the day it is added. The refresh token is never kept or sent anywhere either. The
// controls prove the check catches a leak and that each secret really is planted.
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { format, inspect } from "node:util";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { findKey } from "../src/key.js";
import { AccessToken, DeviceCode } from "../src/signin/secret.js";
import {
  ACCESS_TOKEN,
  DEVICE_CODE,
  FakeServer,
  NEW_KEY_CORE,
  NEW_KEY_MARKERS,
  newKey,
  REFRESH_TOKEN,
  SIGN_IN_MARKERS,
  type KeysAnswer,
  type TokenAnswer,
  type WhoamiAnswer,
} from "./fake-server.js";
import { fakeClock, memoryKeyring, runCli, spawnCli, spawnCliAsync, testStore, unreachableKeyring } from "./helpers.js";

// Built from parts, so no file in this repository holds a whole key-shaped string.
const CORE = ["PLANTED", "KEY", "7f3a9c"].join("");
const IN_ENVIRONMENT = ["haau3", "sk", "live", `${CORE}env`].join("_");
const IN_ENV_LOCAL = ["haau3", "sk", "test", `${CORE}local`].join("_");
const IN_ENV = ["haau3", "sk", "live", `${CORE}dotenv`].join("_");
const NEIGHBOUR = ["PLANTED", "NEIGHBOUR", "e41b07"].join("");
const PLANTED = [IN_ENVIRONMENT, IN_ENV_LOCAL, IN_ENV, CORE, NEIGHBOUR, ...SIGN_IN_MARKERS, ...NEW_KEY_MARKERS];

/** Throws, without repeating it, when `text` holds anything planted. */
function assertClean(text: string, where: string): void {
  const hit = PLANTED.findIndex((planted) => text.includes(planted));
  if (hit !== -1) throw new Error(`${where} shows planted secret number ${hit}`);
}

/**
 * Every argument list the command line accepts or refuses, and the planted key typed where a command,
 * a flag or an argument would be. Each has a label, so no test's name holds a key-shaped string.
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
  ["login", ["login"]],
  ["login --complete", ["login", "--complete"]],
  ["whoami", ["whoami"]],
  ["logout", ["logout"]],
  ["the key as a command", [IN_ENVIRONMENT]],
  ["the key as a flag", [`--${IN_ENVIRONMENT}`]],
  ["the key as --json's value", [`--json=${IN_ENVIRONMENT}`]],
  ["the key as an unknown flag's value", [`--key=${IN_ENVIRONMENT}`]],
  ["the key after help", ["help", IN_ENVIRONMENT]],
  ["the key after --", ["--", IN_ENVIRONMENT]],
  ["the key after login", ["login", IN_ENVIRONMENT]],
  ["the key as --complete's value", ["login", `--complete=${IN_ENVIRONMENT}`]],
  ["the key after whoami", ["whoami", IN_ENVIRONMENT]],
  ["keys create", ["keys", "create"]],
  ["keys create --test", ["keys", "create", "--test"]],
  ["keys create --replace", ["keys", "create", "--replace"]],
  ["keys alone", ["keys"]],
  ["the key after keys", ["keys", IN_ENVIRONMENT]],
  ["the key after keys create", ["keys", "create", IN_ENVIRONMENT]],
  ["the key as --name's value", ["keys", "create", `--name=${IN_ENVIRONMENT}`]],
  ["the key after --name", ["keys", "create", "--name", IN_ENVIRONMENT]],
  ["the key as --file's value", ["keys", "create", `--file=${IN_ENVIRONMENT}`]],
  ["the key after --file", ["keys", "create", "--file", IN_ENVIRONMENT]],
  ["the key as an env file's name", ["keys", "create", "--file", `.env${IN_ENVIRONMENT}`]],
  ["the key as --test's value", ["keys", "create", `--test=${IN_ENVIRONMENT}`]],
  ["the key after a flag's value took the command's word", ["--name", "keys", IN_ENVIRONMENT]],
  ["the key after --file took the command's word", ["--file", "keys", IN_ENVIRONMENT, "create"]],
  ["the key as Node's own --env-file", ["keys", "create", `--env-file=${IN_ENVIRONMENT}`]],
];

let project: string;
beforeAll(() => {
  project = mkdtempSync(join(tmpdir(), "cli-secrets-"));
  writeFileSync(join(project, ".env.local"), `NEIGHBOUR_TOKEN=${NEIGHBOUR}\nHAAU3_API_KEY=${IN_ENV_LOCAL}\n`);
  writeFileSync(join(project, ".env"), `HAAU3_API_KEY=${IN_ENV}\nNEIGHBOUR_TOKEN=${NEIGHBOUR}\n`);
});
afterAll(() => rmSync(project, { recursive: true, force: true }));

let server: FakeServer;
let dir: string;
beforeEach(async () => {
  server = await new FakeServer().start();
  dir = mkdtempSync(join(tmpdir(), "cli-secrets-store-"));
});
afterEach(async () => {
  await server.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe("the controls", () => {
  it("catch a planted secret, and whatever util.inspect shows of one", () => {
    expect(() => assertClean(`using ${IN_ENV_LOCAL}`, "a leaky line")).toThrow("a leaky line shows planted secret number 1");
    expect(() => assertClean(inspect({ token: NEIGHBOUR }), "an inspected object")).toThrow();
    expect(() => assertClean(`prefix ${CORE}... truncated`, "a truncated key")).toThrow();
    for (const marker of [ACCESS_TOKEN, REFRESH_TOKEN, DEVICE_CODE]) expect(() => assertClean(`Bearer ${marker}`, "a token")).toThrow();
    expect(() => assertClean("nothing here", "a clean line")).not.toThrow();
  });

  it("are planted where the command line looks", () => {
    expect(findKey({ cwd: project, env: { HAAU3_API_KEY: IN_ENVIRONMENT } }).key?.reveal()).toBe(IN_ENVIRONMENT);
    expect(findKey({ cwd: project, env: {} }).key?.reveal()).toBe(IN_ENV_LOCAL);
  });

  it("are handed out by the stand-in sign-in service, and kept: the access token and the device code", async () => {
    const keyring = memoryKeyring();
    const run = (args: string[]) => runCli(args, { env: { HAAU3_PLATFORM_URL: server.url }, io: { store: testStore(dir, keyring), ...fakeClock() } });
    await run(["login"]);
    expect(keyring.entries.get(server.url)).toContain(DEVICE_CODE);
    await run(["login", "--complete"]);
    expect(keyring.entries.get(server.url)).toContain(ACCESS_TOKEN);
    expect(server.requests.some((r) => r.headers.authorization === `Bearer ${ACCESS_TOKEN}`)).toBe(true);
  });
});

/** What the stand-in answers, scenario by scenario: each run of a command sees one of these. */
const SCENARIOS: { label: string; tokens: TokenAnswer[]; whoami: WhoamiAnswer; revokeStatus: number }[] = [
  { label: "approved", tokens: ["approved"], whoami: "ok", revokeStatus: 200 },
  { label: "slowed then approved", tokens: ["slow_down", "pending", "approved"], whoami: "ok", revokeStatus: 200 },
  { label: "still pending", tokens: ["pending"], whoami: "ok", revokeStatus: 200 },
  { label: "denied", tokens: ["denied"], whoami: "ok", revokeStatus: 200 },
  { label: "refused by the sign-in service", tokens: ["invalid_grant"], whoami: "ok", revokeStatus: 200 },
  { label: "refused by the platform", tokens: ["approved"], whoami: "unauthorized", revokeStatus: 200 },
  { label: "not a member", tokens: ["approved"], whoami: "not-a-member", revokeStatus: 200 },
  { label: "the platform down", tokens: ["approved"], whoami: "unavailable", revokeStatus: 503 },
];

describe("no command prints a planted secret", () => {
  for (const [label, args] of COMMANDS) {
    it(`${label}, at a terminal and not, as text and as JSON`, async () => {
      for (const tty of [true, false]) {
        for (const output of ["", "json", "text"]) {
          const env = { HAAU3_API_KEY: IN_ENVIRONMENT, NEIGHBOUR_TOKEN: NEIGHBOUR, HAAU3_OUTPUT: output, HAAU3_PLATFORM_URL: server.url };
          const out = await runCli(args, { tty, env, cwd: project, io: { store: testStore(dir, memoryKeyring()), ...fakeClock() } });
          assertClean(out.stdout, "stdout");
          assertClean(out.stderr, "stderr");
        }
      }
    });
  }

  for (const scenario of SCENARIOS) {
    it(`signing in, and the session's commands, when ${scenario.label}`, async () => {
      for (const person of [false, true]) {
        for (const output of ["", "json", "text"]) {
          for (const keyring of [memoryKeyring(), unreachableKeyring()]) {
            Object.assign(server, { tokenAnswers: scenario.tokens, whoamiAnswer: "ok", revokeStatus: 200 });
            const store = testStore(dir, keyring);
            const env = { HAAU3_API_KEY: IN_ENVIRONMENT, HAAU3_OUTPUT: output, HAAU3_PLATFORM_URL: server.url };
            const io = { store, ...fakeClock(), ...(person ? { stdin: { isTTY: true }, openBrowser: async () => true, enter: () => ({ pressed: Promise.resolve(), stop() {} }) } : {}) };
            const run = async (args: string[]) => {
              const out = await runCli(args, { tty: person, env, cwd: project, io });
              assertClean(out.stdout, `stdout of ${args.join(" ")}`);
              assertClean(out.stderr, `stderr of ${args.join(" ")}`);
            };
            await run(["login"]);
            await run(["login"]);
            await run(["login", "--complete"]);
            server.whoamiAnswer = scenario.whoami;
            server.revokeStatus = scenario.revokeStatus;
            await run(["login"]);
            await run(["whoami"]);
            await run(["logout"]);
            await run(["whoami"]);
            await run(["logout"]);
            await store.clear(server.url);
          }
        }
      }
      // The refresh token is never kept, and never sent anywhere.
      expect(readFileOr(join(dir, "session.json"))).not.toContain(REFRESH_TOKEN);
      expect(server.requests.map((r) => r.body + JSON.stringify(r.headers)).join("")).not.toContain(REFRESH_TOKEN);
    });
  }

  it("as a real process, whose stdout is a pipe", () => {
    const labels = ["no arguments", "--version", "--json --help", "an unknown command", "the key as a command", "the key as --json's value", "the key after login"];
    for (const [label, args] of COMMANDS.filter(([l]) => labels.includes(l))) {
      const out = spawnCli(args, { cwd: project, env: { HAAU3_API_KEY: IN_ENVIRONMENT, NEIGHBOUR_TOKEN: NEIGHBOUR } });
      expect(out.code === 0 || out.code === 2, label).toBe(true);
      assertClean(out.stdout, `stdout of ${label}`);
      assertClean(out.stderr, `stderr of ${label}`);
    }
  });

  it("signing in as a real process, the session in a file, which never holds the refresh token", async () => {
    server.interval = 1;
    const env = { HAAU3_API_KEY: IN_ENVIRONMENT, HAAU3_PLATFORM_URL: server.url, HAAU3_SESSION_STORE: "file", HAAU3_CONFIG_DIR: dir };
    for (const args of [["login"], ["login", "--complete"], ["whoami"]]) {
      const out = await spawnCliAsync(args, { cwd: project, env });
      expect(out.code, args.join(" ")).toBe(0);
      assertClean(out.stdout, `stdout of ${args.join(" ")}`);
      assertClean(out.stderr, `stderr of ${args.join(" ")}`);
    }
    const kept = readFileSync(join(dir, "session.json"), "utf8");
    expect(kept).toContain(ACCESS_TOKEN);
    expect(kept).not.toContain(REFRESH_TOKEN);
    const out = await spawnCliAsync(["logout"], { cwd: project, env });
    expect(out.code).toBe(0);
    assertClean(out.stdout + out.stderr, "logout");
  });
});

/** Every file under a folder, with its text. */
function filesUnder(folder: string): [string, string][] {
  return readdirSync(folder, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const path = join(entry.parentPath, entry.name);
      return [path, readFileSync(path, "utf8")] as [string, string];
    });
}

/** What the stand-in can answer when a key is asked for, each run through every way of running. */
const KEY_ANSWERS: KeysAnswer[] = [
  "created",
  "garbled",
  "wrong-mode",
  "bad-secret",
  "key-in-id",
  "key-in-name",
  "long-prefix",
  "key-in-problem",
  "ok-200",
  "unauthorized",
  "not-a-member",
  "unavailable",
  "server-error",
  "off",
  "no-answer",
];

describe("a new key is written to the env file and nowhere else", () => {
  for (const answer of KEY_ANSWERS) {
    it(`when the platform answers ${answer}`, async () => {
      for (const person of [false, true]) {
        for (const output of ["", "json", "text"]) {
          for (const keyring of [memoryKeyring(), unreachableKeyring()]) {
            const keys = mkdtempSync(join(tmpdir(), "cli-secrets-keys-"));
            try {
              writeFileSync(join(keys, ".env"), `NEIGHBOUR_TOKEN=${NEIGHBOUR}\r\nHAAU3_API_KEY=${IN_ENV}\r\n`);
              Object.assign(server, { tokenAnswers: ["approved"], whoamiAnswer: "ok", revokeStatus: 200, keysAnswer: "created" });
              const store = testStore(dir, keyring);
              const env = { HAAU3_API_KEY: IN_ENVIRONMENT, HAAU3_OUTPUT: output, HAAU3_PLATFORM_URL: server.url };
              const io = { store, ...fakeClock(), ...(person ? { stdin: { isTTY: true }, openBrowser: async () => true, enter: () => ({ pressed: Promise.resolve(), stop() {} }) } : {}) };
              /** The session's stores and everything sent, read while the session is still kept. */
              const storesClean = (when: string) => {
                for (const [path, text] of filesUnder(dir)) expect(text.includes(NEW_KEY_CORE), `${path} after ${when}`).toBe(false);
                if ("entries" in keyring) expect([...keyring.entries.values()].join(""), `the credential store after ${when}`).not.toContain(NEW_KEY_CORE);
                expect(server.requests.map((r) => r.body + JSON.stringify(r.headers)).join("")).not.toContain(NEW_KEY_CORE);
              };
              const run = async (args: string[]) => {
                const out = await runCli(args, { tty: person, env, cwd: keys, io });
                assertClean(out.stdout, `stdout of ${args.join(" ")}`);
                assertClean(out.stderr, `stderr of ${args.join(" ")}`);
                storesClean(args.join(" "));
                return out;
              };
              await run(["login"]);
              await run(["login", "--complete"]);
              await run(["keys", "create"]);
              server.keysAnswer = answer;
              await run(["keys", "create", "--replace"]);
              server.keysAnswer = "created";
              await run(["keys", "create", "--test", "--file", "sandbox.env"]);
              await run(["whoami"]);
              await run(["logout"]);
              await store.clear(server.url);

              // The live key is in .env, which kept its neighbour and its line endings, only when it was made.
              const files = filesUnder(keys);
              const holding = (secret: string) => files.filter(([, text]) => text.includes(secret)).map(([path]) => path);
              if (answer === "created") {
                expect(holding(newKey("live"))).toEqual([join(keys, ".env")]);
                expect(readFileSync(join(keys, ".env"), "utf8")).toBe(`NEIGHBOUR_TOKEN=${NEIGHBOUR}\r\nHAAU3_API_KEY=${newKey("live")}\r\n`);
              } else {
                expect(holding(newKey("live"))).toEqual([]);
                expect(readFileSync(join(keys, ".env"), "utf8")).toBe(`NEIGHBOUR_TOKEN=${NEIGHBOUR}\r\nHAAU3_API_KEY=${IN_ENV}\r\n`);
              }
              // A refused session is ended, so the test key that follows is never made.
              const ended = answer === "unauthorized" || answer === "not-a-member";
              expect(holding(newKey("test"))).toEqual(ended ? [] : [join(keys, "sandbox.env")]);
            } finally {
              rmSync(keys, { recursive: true, force: true });
            }
          }
        }
      }
    });
  }

  it("as a real process, the session in a file", async () => {
    server.interval = 1;
    const keys = mkdtempSync(join(tmpdir(), "cli-secrets-keys-"));
    try {
      const env = { HAAU3_API_KEY: IN_ENVIRONMENT, HAAU3_PLATFORM_URL: server.url, HAAU3_SESSION_STORE: "file", HAAU3_CONFIG_DIR: dir };
      // --file as a real process too: a flag Node took as its own would never reach the command line.
      const runs = [["login"], ["login", "--complete"], ["keys", "create"], ["keys", "create"], ["keys", "create", "--test", "--file", "sandbox.env"], ["keys", "create", `--file=${IN_ENVIRONMENT}.env`]];
      for (const args of runs) {
        const out = await spawnCliAsync(args, { cwd: keys, env });
        expect(out.stdout.startsWith("{"), `${args[0]} printed its document`).toBe(true);
        assertClean(out.stdout, `stdout of ${args.join(" ")}`);
        assertClean(out.stderr, `stderr of ${args.join(" ")}`);
      }
      // Read while the session is still kept, then once more after logout.
      for (const [path, text] of filesUnder(dir)) expect(text.includes(NEW_KEY_CORE), path).toBe(false);
      assertClean((await spawnCliAsync(["logout"], { cwd: keys, env })).stdout, "logout");
      expect(readFileSync(join(keys, ".env"), "utf8")).toBe(`HAAU3_API_KEY=${newKey("live")}\n`);
      expect(readFileSync(join(keys, "sandbox.env"), "utf8")).toBe(`HAAU3_API_KEY=${newKey("test")}\n`);
      expect(filesUnder(keys).map(([path]) => path).sort()).toEqual([join(keys, ".env"), join(keys, "sandbox.env")]);
    } finally {
      rmSync(keys, { recursive: true, force: true });
    }
  });
});

function readFileOr(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

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

describe("an access token and a device code print as hidden however they are printed", () => {
  for (const [label, secret, shownAs] of [
    ["an access token", new AccessToken(ACCESS_TOKEN), "[haau3 token hidden]"],
    ["a device code", new DeviceCode(DEVICE_CODE), "[haau3 device code hidden]"],
  ] as const) {
    it(label, () => {
      const holder = { secret, nested: { secret } };
      const shown = [
        JSON.stringify(holder),
        inspect(holder, { depth: Infinity, showHidden: true }),
        format("%s %o %O %j", secret, secret, holder, holder),
        String(secret),
        `${secret}`,
        secret + "",
        new Error(`the call with ${secret} failed`).message,
        JSON.stringify({ ...secret }),
        JSON.stringify(Object.entries(secret)),
      ];
      for (const [i, text] of shown.entries()) assertClean(text, `printing number ${i}`);
      expect(String(secret)).toBe(shownAs);
      expect(secret.reveal()).toBe(label === "an access token" ? ACCESS_TOKEN : DEVICE_CODE);
    });
  }
});
