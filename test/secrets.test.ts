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
  type ApiAnswer,
  DEVICE_CODE,
  FakeServer,
  LISTED_KEY_ID,
  listedKeys,
  MANAGED_KEY_ID,
  NEW_KEY_CORE,
  NEW_KEY_MARKERS,
  QUERY_MARKER,
  newKey,
  REFRESH_TOKEN,
  REVOKED_KEY_ID,
  SIGN_IN_MARKERS,
  UNKNOWN_KEY_ID,
  type KeysAnswer,
  type RevokeKeyAnswer,
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
const PLANTED = [IN_ENVIRONMENT, IN_ENV_LOCAL, IN_ENV, CORE, NEIGHBOUR, QUERY_MARKER, ...SIGN_IN_MARKERS, ...NEW_KEY_MARKERS];

/**
 * Throws, without repeating it, when `text` holds anything planted: in any case, and with its
 * separators changed, since a command could repeat a secret lower-cased or hyphenated.
 */
function assertClean(text: string, where: string): void {
  const fold = (s: string) => s.toLowerCase().replace(/[-_ ]/g, "");
  const folded = fold(text);
  const hit = PLANTED.findIndex((planted) => folded.includes(fold(planted)));
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
  ["keys list", ["keys", "list"]],
  ["keys list --all", ["keys", "list", "--all"]],
  ["keys revoke", ["keys", "revoke", LISTED_KEY_ID]],
  ["keys revoke with no id", ["keys", "revoke"]],
  ["the key as keys revoke's id", ["keys", "revoke", IN_ENVIRONMENT]],
  ["the key after keys revoke's id", ["keys", "revoke", LISTED_KEY_ID, IN_ENVIRONMENT]],
  ["the key after keys list", ["keys", "list", IN_ENVIRONMENT]],
  ["the key as --all's value", ["keys", "list", `--all=${IN_ENVIRONMENT}`]],
  ["the key as a flag of keys revoke", ["keys", "revoke", LISTED_KEY_ID, `--${IN_ENVIRONMENT}`]],
  ["doctor", ["doctor"]],
  ["doctor --file", ["doctor", "--file", ".env"]],
  ["the key after doctor", ["doctor", IN_ENVIRONMENT]],
  ["the key as doctor's --file", ["doctor", "--file", IN_ENVIRONMENT]],
  ["the key as doctor's env file's name", ["doctor", "--file", `.env${IN_ENVIRONMENT}`]],
  ["test", ["test"]],
  ["test a service", ["test", "fhir-base"]],
  ["test --all", ["test", "fhir-base", "--all"]],
  ["test --file", ["test", "--file", ".env"]],
  ["the key as test's service", ["test", IN_ENVIRONMENT]],
  ["the key after test's service", ["test", "fhir-base", IN_ENVIRONMENT]],
  ["the key as test's --file", ["test", "--file", IN_ENVIRONMENT]],
  ["the key as test's --all value", ["test", `--all=${IN_ENVIRONMENT}`]],
  ["init", ["init"]],
  ["init --no-agent", ["init", "--no-agent"]],
  ["init --file", ["init", "--no-agent", "--file", ".env"]],
  ["the key after init", ["init", IN_ENVIRONMENT]],
  ["the key as init's --agent", ["init", "--agent", IN_ENVIRONMENT]],
  ["the key as init's --language", ["init", `--language=${IN_ENVIRONMENT}`]],
  ["the key as init's --package-manager", ["init", "--package-manager", IN_ENVIRONMENT]],
  ["the key as init's --file", ["init", "--file", IN_ENVIRONMENT]],
];

let project: string;
beforeAll(() => {
  project = mkdtempSync(join(tmpdir(), "cli-secrets-"));
  // A Next.js project, whose loader reads .env.local over .env, so both planted files are read.
  writeFileSync(join(project, "package.json"), JSON.stringify({ dependencies: { next: "16.0.0" } }));
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
          // doctor calls the API: here, the stand-in, which is the only place a key may go.
          const env = { HAAU3_API_KEY: IN_ENVIRONMENT, NEIGHBOUR_TOKEN: NEIGHBOUR, HAAU3_OUTPUT: output, HAAU3_PLATFORM_URL: server.url, HAAU3_BASE_URL: server.url };
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
              // Refused before the platform is asked (.env holds a key already), so the session is kept.
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
              // Every answer to the --replace ends the session, so the test key that follows is never
              // made, except a 400 or a 404, which spend nothing. The rest refuse the session (401,
              // 403) or made or may have made a key (any success, used or not, a failure, no answer).
              const kept = answer === "key-in-problem" || answer === "off";
              const ended = !kept;
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
      // Making a key ends the sign-in: the second `keys create` finds none, and the next key signs in
      // again. The last sign-in is kept, so the store is read with a session in it.
      const signIn = [["login"], ["login", "--complete"]];
      const runs = [
        ...signIn,
        ["keys", "create"],
        ["keys", "create"],
        ...signIn,
        ["keys", "create", "--test", "--file", "sandbox.env"],
        ...signIn,
        ["keys", "create", `--file=${IN_ENVIRONMENT}.env`],
      ];
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

/** What the stand-in can answer when a key is revoked, each run through every way of running. */
const REVOKE_ANSWERS: RevokeKeyAnswer[] = ["revoked", "raced", "gone", "unauthorized", "not-a-member", "unavailable", "no-answer", "garbled", "refused", "off"];

describe("listing and revoking keys never prints a key", () => {
  for (const answer of REVOKE_ANSWERS) {
    it(`when a revoke is answered ${answer}, a key's name holding a planted key`, async () => {
      for (const person of [false, true]) {
        for (const output of ["", "json", "text"]) {
          for (const keyring of [memoryKeyring(), unreachableKeyring()]) {
            // The keys page takes any name, a key included: the platform lists it as it is.
            const listed = listedKeys();
            listed[0]!.name = `prod ${IN_ENV}`;
            listed[2]!.name = IN_ENV_LOCAL;
            Object.assign(server, { listed, tokenAnswers: ["approved"], whoamiAnswer: "ok", revokeStatus: 200, revokeKeyAnswer: answer, listAnswer: "ok", readAnswer: "ok" });
            const store = testStore(dir, keyring);
            const env = { HAAU3_API_KEY: IN_ENVIRONMENT, HAAU3_OUTPUT: output, HAAU3_PLATFORM_URL: server.url };
            const shown: string[] = [];
            const confirm = async (question: string, prompt: string) => (shown.push(question, prompt), true);
            const io = {
              store,
              ...fakeClock(),
              ...(person ? { stdin: { isTTY: true }, openBrowser: async () => true, enter: () => ({ pressed: Promise.resolve(), stop() {} }), confirm } : {}),
            };
            const run = async (args: string[]) => {
              const out = await runCli(args, { tty: person, env, cwd: project, io });
              assertClean(out.stdout, `stdout of keys ${args[1]}`);
              assertClean(out.stderr, `stderr of keys ${args[1]}`);
            };
            await run(["login"]);
            await run(["login", "--complete"]);
            await run(["keys", "list"]);
            await run(["keys", "list", "--all"]);
            for (const id of [MANAGED_KEY_ID, REVOKED_KEY_ID, UNKNOWN_KEY_ID, IN_ENVIRONMENT, LISTED_KEY_ID]) await run(["keys", "revoke", id]);
            await run(["keys", "list"]);
            await run(["whoami"]);
            await run(["logout"]);
            await store.clear(server.url);
            // What a person was asked showed no key either.
            for (const text of shown) assertClean(text, "the question");
          }
        }
      }
      // The typed key was never sent anywhere.
      expect(server.requests.map((r) => r.path + r.body).join("")).not.toContain(IN_ENVIRONMENT);
    });
  }
});

/** Planted under other names, where doctor looks for a near-miss: their values and names are never printed. */
const NEAR_VALUE = ["haau3", "sk", "test", `${CORE}near`].join("_");
const NEAR_NAME = ["haau3", "sk", "live", `${CORE}name`].join("_");

describe("doctor never prints a key, a near-miss's value or name, or what the API sent back", () => {
  const answers: ApiAnswer[] = ["ok", "unauthorized", "rate-limited", "unavailable", "echo"];
  let near: string;
  beforeEach(() => {
    near = mkdtempSync(join(tmpdir(), "cli-secrets-doctor-"));
    writeFileSync(join(near, ".env.local"), `HAAU3_TEST_API_KEY=${NEAR_VALUE}\nMY_TOKEN=${NEAR_VALUE}\n${NEAR_NAME}=1\nNEIGHBOUR_TOKEN=${NEIGHBOUR}\n`);
    writeFileSync(join(near, ".env"), `HAAU3_API_KEY=${IN_ENV}\n`);
  });
  afterEach(() => rmSync(near, { recursive: true, force: true }));

  for (const answer of answers) {
    it(`when the API answers ${answer}, at a terminal and not, as text and as JSON`, async () => {
      server.apiAnswer = answer;
      for (const tty of [true, false]) {
        for (const output of ["", "json", "text"]) {
          for (const env of [
            { HAAU3_BASE_URL: server.url },
            { HAAU3_BASE_URL: server.url, HAAU3_API_KEY: IN_ENVIRONMENT },
            { HAAU3_BASE_URL: server.url, HAAU3_ENVIRONMENT: "sandbox", HAAU3_API_KEY: IN_ENV_LOCAL },
            { HAAU3_BASE_URL: `${server.url}/${IN_ENVIRONMENT}` },
            { HAAU3_BASE_URL: server.url.replace("http://127.0.0.1", `http://u:${IN_ENVIRONMENT}@127.0.0.1`) },
          ]) {
            const before = server.requests.length;
            const out = await runCli(["doctor"], {
              tty,
              env: { HAAU3_OUTPUT: output, HAAU3_PLATFORM_URL: server.url, NEIGHBOUR_TOKEN: NEIGHBOUR, OTHER_KEY: NEAR_VALUE, ...env },
              cwd: near,
              io: { store: testStore(dir, memoryKeyring()), ...fakeClock() },
            });
            assertClean(out.stdout, "stdout");
            assertClean(out.stderr, "stderr");
            // A base URL that holds a key is never called, so the key goes nowhere.
            if (env.HAAU3_BASE_URL !== server.url) expect(server.requests.length).toBe(before);
          }
        }
      }
      // Nothing doctor sent carried a near-miss's value: only HAAU3_API_KEY is ever sent.
      expect(JSON.stringify(server.requests.map((r) => r.headers))).not.toContain(`${CORE}near`);
    });
  }

  it("as a real process, whose stdout is a pipe", async () => {
    server.apiAnswer = "echo";
    const env = { HAAU3_BASE_URL: server.url, HAAU3_PLATFORM_URL: server.url, HAAU3_SESSION_STORE: "file", HAAU3_CONFIG_DIR: dir, OTHER_KEY: NEAR_VALUE };
    for (const args of [["doctor"], ["doctor", "--file", ".env.local"]]) {
      const out = await spawnCliAsync(args, { cwd: near, env });
      expect(out.stdout.startsWith("{"), args.join(" ")).toBe(true);
      expect(out.code).toBe(1);
      assertClean(out.stdout, `stdout of ${args.join(" ")}`);
      assertClean(out.stderr, `stderr of ${args.join(" ")}`);
    }
    expect(server.to("/v1/fhir/r4/metadata").length).toBeGreaterThan(0);
  });
});

describe("test never prints a key, or what the API sent back", () => {
  const answers: ApiAnswer[] = ["ok", "unauthorized", "rate-limited", "unavailable", "echo"];
  for (const answer of answers) {
    it(`when the API answers ${answer}, at a terminal and not, as text and as JSON`, async () => {
      server.apiAnswer = answer;
      for (const tty of [true, false]) {
        for (const output of ["", "json", "text"]) {
          for (const env of [
            { HAAU3_BASE_URL: server.url },
            { HAAU3_BASE_URL: server.url, HAAU3_API_KEY: IN_ENVIRONMENT },
            { HAAU3_BASE_URL: server.url, HAAU3_ENVIRONMENT: "sandbox", HAAU3_API_KEY: IN_ENV_LOCAL },
            { HAAU3_BASE_URL: `${server.url}/${IN_ENVIRONMENT}` },
            { HAAU3_BASE_URL: server.url.replace("http://127.0.0.1", `http://u:${IN_ENVIRONMENT}@127.0.0.1`) },
          ]) {
            const before = server.requests.length;
            for (const args of [["test"], ["test", "fhir-base", "--all"]]) {
              const out = await runCli(args, {
                tty,
                env: { HAAU3_OUTPUT: output, HAAU3_PLATFORM_URL: server.url, NEIGHBOUR_TOKEN: NEIGHBOUR, ...env },
                cwd: project,
                io: { store: testStore(dir, memoryKeyring()), ...fakeClock() },
              });
              assertClean(out.stdout, `stdout of ${args.join(" ")}`);
              assertClean(out.stderr, `stderr of ${args.join(" ")}`);
            }
            // A base URL that holds a key is never called, so the key goes nowhere.
            if (env.HAAU3_BASE_URL !== server.url) expect(server.requests.length).toBe(before);
          }
        }
      }
      // test read the spec and called the API here, so the check above saw real answers.
      expect(server.to("/openapi.json").length).toBeGreaterThan(0);
      expect(server.to("/v1/fhir/r4/metadata").length).toBeGreaterThan(0);
    });
  }

  it("as a real process, whose stdout is a pipe, and as text", async () => {
    server.apiAnswer = "echo";
    const env = { HAAU3_BASE_URL: server.url, HAAU3_PLATFORM_URL: server.url, HAAU3_SESSION_STORE: "file", HAAU3_CONFIG_DIR: dir, HAAU3_API_KEY: IN_ENVIRONMENT };
    for (const [args, output] of [
      [["test"], ""],
      [["test", "fhir-base", "--all"], ""],
      [["test", "fhir-base", "--all"], "text"],
      [["test", "--file", ".env"], ""],
    ] as const) {
      const out = await spawnCliAsync([...args], { cwd: project, env: { ...env, HAAU3_OUTPUT: output } });
      if (output === "") expect(out.stdout.startsWith("{"), args.join(" ")).toBe(true);
      expect([0, 1], args.join(" ")).toContain(out.code);
      assertClean(out.stdout, `stdout of ${args.join(" ")}`);
      assertClean(out.stderr, `stderr of ${args.join(" ")}`);
    }
    // The spec repeated the key into its names, and its query marker was sent: what test read was hostile.
    expect(server.to("/v1/fhir/r4/Echo").length).toBeGreaterThan(0);
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
