// haau3 doctor in real folders and real git repositories, against a stand-in API given as the fetch
// the SDK sends with: every check and every status, in text and in JSON, where each setting is found,
// where each call goes, and that the key goes nowhere else and is never printed.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CHECKS, shownBase, type Check } from "../src/commands/doctor.js";
import { FORMAT_VERSION } from "../src/output.js";
import type { StoredRecord } from "../src/session/record.js";
import { VERSION } from "../src/version.js";
import { ACCESS_TOKEN, DEVICE_CODE } from "./fake-server.js";
import { cleanEnv, fakeClock, memoryKeyring, runCli, testStore, unreachableKeyring } from "./helpers.js";

// Built from parts, so no file in this repository holds a whole key-shaped string.
const LIVE = ["haau3", "sk", "live", `DOCTORLIVE${"a".repeat(33)}`].join("_");
const TEST = ["haau3", "sk", "test", `DOCTORTEST${"b".repeat(33)}`].join("_");
const OLDER = ["haau3", "sk", `DOCTOROLDR${"c".repeat(33)}`].join("_");
const MARKERS = ["DOCTORLIVE", "DOCTORTEST", "DOCTOROLDR", "DOCTORNEAR", ACCESS_TOKEN, DEVICE_CODE];
const NEAR = ["haau3", "sk", "test", `DOCTORNEAR${"d".repeat(33)}`].join("_");

const PLATFORM = "http://127.0.0.1:59998";
const PRODUCTION = "https://api.haau3.com";
const SANDBOX = "https://sandbox.haau3.com";
const REQUEST_ID = "6b1f3c2e-4d5a-4b6c-8d7e-9f0a1b2c3d4e";

interface Sent {
  url: URL;
  method: string;
  headers: Headers;
}

type Answer = (url: URL) => Response | Promise<Response>;

const json = (status: number, body: unknown, headers: Record<string, string> = {}, type = "application/json") =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": type, "x-request-id": REQUEST_ID, ...headers } });
const fhir = (status: number, body: unknown, headers: Record<string, string> = {}) => json(status, body, headers, "application/fhir+json; fhirVersion=4.0");
const outcome = (code: string, apiCode?: string) => ({
  resourceType: "OperationOutcome",
  issue: [
    {
      severity: "error",
      code,
      diagnostics: "The API's own words.",
      ...(apiCode ? { details: { coding: [{ system: "https://haau3.com/fhir/CodeSystem/api-error", code: apiCode }] } } : {}),
    },
  ],
});

/** The API answering well: /health, then metadata. */
const healthy: Answer = (url) => (url.pathname === "/health" ? json(200, { status: "ok" }) : fhir(200, { resourceType: "CapabilityStatement", status: "active" }));

/** A stand-in API: the fetch the SDK is given, and every request it received. */
function api(answer: Answer = healthy) {
  const sent: Sent[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    sent.push({ url, method: init?.method ?? "GET", headers: new Headers(init?.headers) });
    return answer(url);
  }) as typeof globalThis.fetch;
  return { fetch, sent };
}

/** The metadata answer replaced, /health still well. */
const metadata = (response: () => Response | Promise<Response>): Answer => (url) => (url.pathname === "/health" ? json(200, { status: "ok" }) : response());

let project: string;
let dir: string;

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), "cli-doctor-project-"));
  dir = mkdtempSync(join(tmpdir(), "cli-doctor-store-"));
});
afterEach(() => {
  rmSync(project, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
});

const write = (name: string, text: string) => {
  mkdirSync(join(project, name, ".."), { recursive: true });
  writeFileSync(join(project, name), text);
};
const git = (...args: string[]) => execFileSync("git", args, { cwd: project, stdio: "ignore" });

/** A Next.js project on @haau3/sdk 0.4.1, installed, whose env files git ignores: its loader reads .env.local, then .env. */
function nodeProject({ sdk = "0.4.1", installed = "0.4.1" as string | null, engines = ">=22", framework = true } = {}) {
  write("package.json", JSON.stringify({ name: "app", dependencies: { "@haau3/sdk": sdk, ...(framework ? { next: "16.0.0" } : {}) } }));
  if (installed) write("node_modules/@haau3/sdk/package.json", JSON.stringify({ name: "@haau3/sdk", version: installed, engines: { node: engines } }));
  git("init", "-q");
  write(".gitignore", ".env*\nnode_modules\n");
}

interface Run {
  args?: string[];
  env?: NodeJS.ProcessEnv;
  tty?: boolean;
  fetch?: typeof globalThis.fetch;
  keyring?: ReturnType<typeof memoryKeyring> | ReturnType<typeof unreachableKeyring>;
  clock?: ReturnType<typeof fakeClock>;
}

async function doctor({ args = [], env = {}, tty = false, fetch = api().fetch, keyring = memoryKeyring(), clock = fakeClock() }: Run = {}) {
  const fullEnv = cleanEnv({ HAAU3_PLATFORM_URL: PLATFORM, ...env });
  const out = await runCli(["doctor", ...args], { tty, env: fullEnv, cwd: project, io: { fetch, store: testStore(dir, keyring, fullEnv), now: clock.now, sleep: clock.sleep } });
  for (const text of [out.stdout, out.stderr]) for (const marker of MARKERS) expect(text).not.toContain(marker);
  return out;
}

/** The document, and each check by name. */
async function report(run: Run = {}) {
  const out = await doctor(run);
  const document = JSON.parse(out.stdout);
  const checks = Object.fromEntries((document.data.checks as Check[]).map((c) => [c.name, c])) as Record<(typeof CHECKS)[number], Check>;
  return { out, document, checks };
}

const statuses = (checks: Record<string, Check>) => Object.fromEntries(Object.entries(checks).map(([name, c]) => [name, c.status]));

describe("every run", () => {
  it("lists the same nine checks, in one order, in the document's shape", async () => {
    nodeProject();
    write(".env.local", `HAAU3_API_KEY=${LIVE}\n`);
    for (const fetch of [api().fetch, api(() => Promise.reject(new TypeError("fetch failed"))).fetch]) {
      const { document } = await report({ fetch });
      expect(document).toMatchObject({ formatVersion: FORMAT_VERSION, cli: "haau3", cliVersion: VERSION, command: "doctor" });
      expect(document.data.checks.map((c: Check) => c.name)).toEqual([...CHECKS]);
      for (const c of document.data.checks as Check[]) {
        expect(["pass", "warn", "fail", "skip"]).toContain(c.status);
        expect(c.message).toEqual(expect.any(String));
        expect(Array.isArray(c.next)).toBe(true);
      }
    }
  });
});

describe("a project that is ready", () => {
  it("passes with a live key in .env.local: production, /health then metadata, the key sent to the API only", async () => {
    nodeProject();
    write(".env.local", `HAAU3_API_KEY=${LIVE}\n`);
    const stand = api();
    const { out, document, checks } = await report({ fetch: stand.fetch });
    expect(out.code).toBe(0);
    expect(document).toMatchObject({ ok: true, environment: "production", error: null });
    expect(document.data).toMatchObject({ ready: true, environment: "production", baseURL: PRODUCTION });
    expect(statuses(checks)).toEqual({
      node: "pass",
      sdk: "pass",
      key: "pass",
      "near-miss": "pass",
      "env-file-ignored": "pass",
      settings: "pass",
      reachable: "pass",
      "key-works": "pass",
      "signed-in": "pass",
    });
    expect(checks.key.message).toBe("HAAU3_API_KEY in .env.local: a live key, for production.");
    expect(checks.key.details).toEqual({ status: "found", source: ".env.local", mode: "live", wellFormed: true });
    expect(checks.settings.message).toBe("The SDK calls production at https://api.haau3.com: the key's mode picks it.");
    expect(checks["key-works"].details).toMatchObject({ status: 200, requestId: REQUEST_ID, withKey: true });
    expect(checks["signed-in"].message).toContain("The key does not need a session");
    expect(stand.sent.map((s) => `${s.url.origin}${s.url.pathname}`)).toEqual([`${PRODUCTION}/health`, `${PRODUCTION}/v1/fhir/r4/metadata`]);
    for (const s of stand.sent) {
      expect(s.headers.get("authorization")).toBe(`Bearer ${LIVE}`);
      expect(s.headers.get("user-agent")).toMatch(new RegExp(` haau3-cli/${VERSION.replaceAll(".", "\\.")}$`));
    }
  });

  it("sends a test key to the Sandbox, and a key made before modes to production", async () => {
    nodeProject();
    for (const [key, host, environment, kind] of [
      [TEST, SANDBOX, "sandbox", "a test key, for the Sandbox"],
      [OLDER, PRODUCTION, "production", "a key made before live and test keys, for production; it does not work in the Sandbox"],
    ] as const) {
      write(".env", `HAAU3_API_KEY=${key}\n`);
      const stand = api();
      const { document, checks } = await report({ fetch: stand.fetch });
      expect(document.environment).toBe(environment);
      expect(checks.key.message).toBe(`HAAU3_API_KEY in .env: ${kind}.`);
      expect(new Set(stand.sent.map((s) => s.url.origin))).toEqual(new Set([host]));
      expect(document.ok).toBe(true);
    }
  });

  it("calls the Sandbox with no key when HAAU3_ENVIRONMENT in .env names it, read as the key is read", async () => {
    nodeProject();
    write(".env", "HAAU3_ENVIRONMENT= Sandbox \n");
    const stand = api();
    const { document, checks } = await report({ fetch: stand.fetch });
    expect(document).toMatchObject({ ok: true, environment: "sandbox" });
    expect(checks.key).toMatchObject({ status: "pass", details: { status: "not-needed", environment: "sandbox" } });
    expect(checks.key.message).toContain("HAAU3_ENVIRONMENT in .env names the Sandbox");
    expect(checks["env-file-ignored"]).toMatchObject({ status: "skip", message: "No key is used, so no file holds one." });
    expect(checks.settings.message).toBe("The SDK calls the Sandbox at https://sandbox.haau3.com: HAAU3_ENVIRONMENT in .env names it.");
    expect(checks["key-works"].message).toMatch(/^the Sandbox answered with no key, in \d+ ms\.$/);
    expect(stand.sent.map((s) => s.url.origin)).toEqual([SANDBOX, SANDBOX]);
    expect(stand.sent.every((s) => !s.headers.has("authorization"))).toBe(true);
    // Without a key, signing in is the way to one, so signed out is a warning.
    expect(checks["signed-in"].status).toBe("warn");
  });

  it("prints readable text at a terminal, naming the environment and its address first", async () => {
    nodeProject();
    write(".env.local", `HAAU3_API_KEY=${LIVE}\n`);
    const out = await doctor({ tty: true });
    expect(out.code).toBe(0);
    expect(out.stderr).toBe("");
    expect(out.stdout.startsWith("Checked this project for production, at https://api.haau3.com.\n\n")).toBe(true);
    expect(out.stdout).toContain("\n  pass  key               HAAU3_API_KEY in .env.local: a live key, for production.\n");
    expect(out.stdout.trimEnd().endsWith("Ready.")).toBe(true);
  });
});

describe("no key", () => {
  it("fails, naming where it looked, with login, keys create and the Sandbox as the remedies, and still checks the network on the Sandbox", async () => {
    nodeProject();
    const stand = api();
    const { out, document, checks } = await report({ fetch: stand.fetch });
    expect(out.code).toBe(1);
    expect(document).toMatchObject({ ok: false, environment: null, error: { code: "not-ready" } });
    // A failing run still carries every check (format 1.3).
    expect(document.data.checks).toHaveLength(CHECKS.length);
    expect(document.data).toMatchObject({ ready: false, environment: null, baseURL: null });
    expect(checks.key.status).toBe("fail");
    expect(checks.key.message).toContain("No API key: HAAU3_API_KEY is not set in the environment, .env.local or .env (.env.local does not exist; .env does not exist).");
    expect(checks.key.next.map((s) => s.command)).toEqual([
      "npx haau3 login",
      "npx haau3 keys create",
      process.platform === "win32" ? '$env:HAAU3_ENVIRONMENT = "sandbox"' : "export HAAU3_ENVIRONMENT=sandbox",
    ]);
    expect(checks.settings).toMatchObject({ status: "skip", details: { waitsOn: "key" } });
    expect(checks.reachable.status).toBe("pass");
    expect(checks["key-works"]).toMatchObject({ status: "skip", details: { waitsOn: "key" } });
    expect(checks["signed-in"]).toMatchObject({ status: "warn", next: [{ command: "npx haau3 login" }] });
    // Only the Sandbox's /health, which needs no key and counts toward nothing.
    expect(stand.sent.map((s) => `${s.url.origin}${s.url.pathname}`)).toEqual([`${SANDBOX}/health`]);
    expect(stand.sent[0]!.headers.has("authorization")).toBe(false);
    expect(document.error.next.map((s: { command: string }) => s.command)).toEqual(checks.key.next.map((s) => s.command));
  });

  it("prints the checks on stdout and why it is not ready on stderr, at a terminal", async () => {
    const out = await doctor({ tty: true });
    expect(out.code).toBe(1);
    expect(out.stdout).toContain("  fail  key               No API key");
    expect(out.stderr.startsWith("Not ready: 1 check failed (key).\n\nNext:\n  npx haau3 login\n")).toBe(true);
  });
});

describe("where the settings are found", () => {
  it("reads the environment before .env.local before .env, for each of the three", async () => {
    nodeProject();
    write(".env.local", `HAAU3_API_KEY=${TEST}\n`);
    write(".env", `HAAU3_API_KEY=${LIVE}\nHAAU3_ENVIRONMENT=sandbox\n`);
    const first = await report();
    expect(first.checks.key.details).toMatchObject({ source: ".env.local", mode: "test" });
    expect(first.checks.settings.details).toMatchObject({ environment: { source: ".env", value: "sandbox" }, baseURL: null });
    const second = await report({ env: { HAAU3_API_KEY: OLDER } });
    expect(second.checks.key.details).toMatchObject({ source: "environment", mode: "older" });
    // The key in use is the shell's, and git is still asked about both files that hold one.
    expect(second.checks["env-file-ignored"]).toMatchObject({
      status: "pass",
      message: "git ignores .env.local and .env.",
      details: { files: [{ file: ".env.local", git: "ignored" }, { file: ".env", git: "ignored" }] },
    });
  });

  it("takes --file in place of .env.local and .env, and refuses a name that is not an env file's", async () => {
    nodeProject();
    write(".env.local", `HAAU3_API_KEY=${LIVE}\n`);
    write("config/prod.env", `HAAU3_API_KEY=${TEST}\n`);
    const { checks } = await report({ args: ["--file", "config/prod.env"] });
    expect(checks.key.details).toMatchObject({ source: join("config", "prod.env"), mode: "test" });
    const missing = await report({ args: ["--file", "other.env"] });
    expect(missing.checks.key.message).toContain("not set in the environment or other.env (other.env does not exist).");
    expect(missing.checks.key.next[1]!.command).toBe("npx haau3 keys create --file other.env");
    const refused = await doctor({ args: ["--file", "notes.txt"] });
    expect(refused.code).toBe(2);
    expect(JSON.parse(refused.stdout)).toMatchObject({ ok: false, data: null, error: { code: "invalid-file" } });
    const pasted = await doctor({ args: ["--file", `.env${LIVE}`] });
    expect(pasted.code).toBe(2);
  });
});

describe("settings the SDK refuses", () => {
  const cases: [string, Record<string, string>, NodeJS.ProcessEnv, RegExp, string | null][] = [
    [
      "a test key with production named",
      { ".env.local": `HAAU3_API_KEY=${TEST}\n`, ".env": "HAAU3_ENVIRONMENT=production\n" },
      {},
      /^HAAU3_API_KEY in \.env\.local is a test key, which works only in the Sandbox, and HAAU3_ENVIRONMENT in \.env names production\./,
      "npx haau3 keys create --file .env.local --replace",
    ],
    [
      "a live key with the Sandbox named",
      { ".env": `HAAU3_API_KEY=${LIVE}\nHAAU3_ENVIRONMENT=sandbox\n` },
      {},
      /^HAAU3_API_KEY in \.env is a live key, which does not work in the Sandbox, and HAAU3_ENVIRONMENT in \.env names the Sandbox\./,
      "npx haau3 keys create --test --file .env --replace",
    ],
    [
      "a key made before modes at the Sandbox's address",
      { ".env": `HAAU3_API_KEY=${OLDER}\n` },
      { HAAU3_BASE_URL: SANDBOX },
      /^HAAU3_API_KEY in \.env was made before live and test keys, so it does not work in the Sandbox, and HAAU3_BASE_URL in the environment is the Sandbox's address\./,
      "npx haau3 keys create --test --file .env --replace",
    ],
    [
      "an environment that is neither",
      { ".env": `HAAU3_API_KEY=${LIVE}\nHAAU3_ENVIRONMENT=staging\n` },
      {},
      /^HAAU3_ENVIRONMENT in \.env is neither production nor sandbox\.$/,
      null,
    ],
    [
      "production named with the Sandbox's address",
      { ".env": `HAAU3_API_KEY=${LIVE}\nHAAU3_ENVIRONMENT=production\n` },
      { HAAU3_BASE_URL: SANDBOX },
      /^HAAU3_ENVIRONMENT in \.env names one environment, and HAAU3_BASE_URL in the environment is the other's own address\./,
      null,
    ],
    [
      "Bearer before the key",
      {},
      { HAAU3_API_KEY: `Bearer ${LIVE}` },
      /^HAAU3_API_KEY in the environment has something before its haau3_sk_ prefix/,
      null,
    ],
  ];

  for (const [name, files, env, message, step] of cases) {
    it(`fails settings, sends nothing, and says which variable and where: ${name}`, async () => {
      nodeProject();
      for (const [file, text] of Object.entries(files)) write(file, text);
      const stand = api();
      const { out, document, checks } = await report({ env, fetch: stand.fetch });
      expect(out.code).toBe(1);
      expect(checks.settings.status).toBe("fail");
      expect(checks.settings.message).toMatch(message);
      expect(checks.settings.message).not.toContain("staging");
      if (step) expect(checks.settings.next.map((s) => s.command)).toEqual([step]);
      expect(checks.reachable).toMatchObject({ status: "skip", details: { waitsOn: "settings" } });
      expect(checks["key-works"]).toMatchObject({ status: "skip", details: { waitsOn: "settings" } });
      expect(document.environment).toBeNull();
      expect(stand.sent).toEqual([]);
    });
  }
});

describe("HAAU3_BASE_URL", () => {
  it("warns, naming where every call goes, and sends the key there only", async () => {
    nodeProject();
    write(".env", `HAAU3_API_KEY=${LIVE}\nHAAU3_BASE_URL=http://localhost:3001/\n`);
    const stand = api();
    const { out, document, checks } = await report({ fetch: stand.fetch });
    expect(out.code).toBe(0);
    expect(checks.settings).toMatchObject({ status: "warn" });
    expect(checks.settings.message).toBe(
      "HAAU3_BASE_URL in .env sends every call to http://localhost:3001, not to production's own address, https://api.haau3.com.",
    );
    expect(document.data.baseURL).toBe("http://localhost:3001");
    expect(new Set(stand.sent.map((s) => s.url.origin))).toEqual(new Set(["http://localhost:3001"]));
  });

  it("is refused, and the key sent nowhere, when it is neither https nor http on this computer, or holds a key", async () => {
    nodeProject();
    for (const [base, said] of [
      ["http://api.example.com", "is neither https nor http on this computer, so haau3 will not send a request there."],
      [`https://user:${LIVE}@api.example.com`, "holds what looks like an API key, so haau3 will not use it."],
      [`https://api.example.com/${LIVE}`, "holds what looks like an API key, so haau3 will not use it."],
    ] as const) {
      write(".env", `HAAU3_API_KEY=${LIVE}\nHAAU3_BASE_URL=${base}\n`);
      const stand = api();
      const { checks } = await report({ fetch: stand.fetch });
      expect(checks.settings.status).toBe("fail");
      expect(checks.settings.message).toBe(`HAAU3_BASE_URL in .env ${said}${said.startsWith("holds") ? " Remove it, and put the key in HAAU3_API_KEY." : " Remove it to call the API at its own address."}`);
      expect(stand.sent).toEqual([]);
    }
  });
});

describe("the key's own shape", () => {
  it("warns about a haau3 key cut short or with a quote after it, and leaves the API to decide", async () => {
    nodeProject();
    for (const value of [LIVE.slice(0, -4), `${LIVE}'`]) {
      write(".env", `HAAU3_API_KEY=${value}\n`);
      const stand = api(metadata(() => fhir(401, outcome("security"))));
      const { checks } = await report({ fetch: stand.fetch });
      expect(checks.key.status).toBe("warn");
      expect(checks.key.message).toContain("a live key, for production, but not a haau3 key's whole shape");
      expect(checks["key-works"].status).toBe("fail");
      expect(stand.sent).toHaveLength(2);
    }
  });

  it("never sends a value that is not a haau3 key: it may be another service's secret (owner, 2026-11-12)", async () => {
    nodeProject();
    const other = ["ghp", "OTHERSERVICE".padEnd(36, "z")].join("_");
    write(".env", `HAAU3_API_KEY=${other}\n`);
    const stand = api();
    const { out, checks } = await report({ fetch: stand.fetch });
    expect(out.code).toBe(1);
    expect(checks.key).toMatchObject({ status: "fail", details: { mode: "unrecognized" } });
    expect(checks.key.message).toContain("not a haau3 key: it does not start with haau3_sk_, so haau3 will not send it");
    expect(checks.key.next.map((s) => s.command)).toEqual(["npx haau3 keys create --replace"]);
    for (const name of ["settings", "reachable", "key-works"] as const) expect(checks[name]).toMatchObject({ status: "skip", details: { waitsOn: "key" } });
    expect(stand.sent).toEqual([]);
    expect(out.stdout).not.toContain("OTHERSERVICE");
  });

  it("never sends a key holding a line break or an invisible character, and says so rather than blaming the network", async () => {
    nodeProject();
    for (const value of [`"${LIVE.slice(0, 20)}\\n${LIVE.slice(20)}"`, `${LIVE}\u200b`]) {
      write(".env", `HAAU3_API_KEY=${value}\n`);
      const stand = api();
      const { checks } = await report({ fetch: stand.fetch });
      expect(checks.key.status).toBe("fail");
      expect(checks.key.message).toContain("holding a character that is not visible text");
      expect(checks.reachable).toMatchObject({ status: "skip", details: { waitsOn: "key" } });
      expect(stand.sent).toEqual([]);
    }
  });
});

describe("the key at work", () => {
  beforeEach(() => {
    nodeProject();
    write(".env.local", `HAAU3_API_KEY=${TEST}\n`);
  });

  it("not taken (401): a fail, with keys create to replace it in its own file", async () => {
    const { checks } = await report({ fetch: api(metadata(() => fhir(401, outcome("security")))).fetch });
    expect(checks["key-works"]).toMatchObject({ status: "fail", details: { problem: { status: 401, requestId: REQUEST_ID } } });
    expect(checks["key-works"].message).toBe("The API did not take the key (401): it is not one the API knows, or it was revoked.");
    expect(checks["key-works"].next.map((s) => s.command)).toEqual(["npx haau3 keys create --test --file .env.local --replace"]);
    expect(checks["signed-in"].status).toBe("warn");
  });

  it("refused in its mode's wrong place (403): a fail that names the code", async () => {
    const { checks } = await report({ fetch: api(metadata(() => fhir(403, outcome("forbidden", "test-key-outside-sandbox")))).fetch });
    expect(checks["key-works"]).toMatchObject({ status: "fail", details: { problem: { status: 403, code: "test-key-outside-sandbox" } } });
    expect(checks["key-works"].message).toContain("it is a test key, at an address that takes live keys");
  });

  it("over a limit (429): a warning with when to try again, and ready otherwise", async () => {
    const { out, checks } = await report({ fetch: api(metadata(() => fhir(429, outcome("throttled"), { "retry-after": "42" }))).fetch });
    expect(out.code).toBe(0);
    expect(checks["key-works"]).toMatchObject({ status: "warn", details: { retryAfter: 42 } });
    expect(checks["key-works"].message).toBe("Over a limit (429), so the key was not proven. It says to try again in 42 s.");
  });

  it("no answer (503, a timeout or the network): a fail with the cold-start note, and no retry", async () => {
    for (const answer of [() => fhir(503, outcome("transient")), () => Promise.reject(new TypeError("fetch failed", { cause: Object.assign(new Error("x"), { code: "ECONNRESET" }) }))]) {
      const stand = api((url) => (url.pathname === "/health" ? json(200, { status: "ok" }) : answer()));
      const { checks } = await report({ fetch: stand.fetch });
      expect(checks["key-works"].status).toBe("fail");
      expect(stand.sent.filter((s) => s.url.pathname.endsWith("/metadata"))).toHaveLength(1);
    }
    const { checks } = await report({ fetch: api(metadata(() => fhir(503, outcome("transient")))).fetch });
    expect(checks["key-works"].message).toContain("An instance of the API may have been starting, which can take up to about 30 seconds. Run this again.");
  });

  it("an answer that is not a CapabilityStatement, or a 404: a fail saying it may not be the haau3 API", async () => {
    for (const answer of [() => json(200, { hello: "world" }), () => json(404, { title: "nope" })]) {
      const { checks } = await report({ fetch: api(metadata(answer)).fetch });
      expect(checks["key-works"].status).toBe("fail");
      expect(checks["key-works"].message).toContain("may not be the haau3 API");
    }
  });

  it("never prints a body, nor a request id that is not one, even when the answer echoes the key", async () => {
    const echo = { resourceType: "OperationOutcome", issue: [{ severity: "error", code: "security", diagnostics: `You sent ${TEST}` }] };
    const stand = api(metadata(() => fhir(401, echo, { "x-request-id": TEST })));
    for (const tty of [false, true]) {
      const out = await doctor({ fetch: stand.fetch, tty });
      expect(out.stdout + out.stderr).not.toContain("You sent");
      if (!tty) expect(JSON.parse(out.stdout).data.checks.find((c: Check) => c.name === "key-works").details.problem).toEqual({ type: "about:blank", title: "HTTP 401", status: 401 });
    }
  });
});

describe("no key in the Sandbox, over its allowance", () => {
  it("warns that a free test key raises it", async () => {
    nodeProject();
    const { out, checks } = await report({ env: { HAAU3_ENVIRONMENT: "sandbox" }, fetch: api(metadata(() => fhir(429, outcome("throttled"), { "retry-after": "1200" }))).fetch });
    expect(out.code).toBe(0);
    expect(checks["key-works"].status).toBe("warn");
    expect(checks["key-works"].message).toBe("Over the Sandbox's allowance for calls with no key from this address (429). It says to try again in 1200 s. A free test key raises it.");
    expect(checks["key-works"].next.map((s) => s.command)).toEqual(["npx haau3 keys create --test"]);
  });
});

describe("reachable", () => {
  beforeEach(() => {
    nodeProject();
    write(".env.local", `HAAU3_API_KEY=${LIVE}\n`);
  });

  it("fails on no connection, naming what failed, and the key check waits on it", async () => {
    const cause = Object.assign(new Error("connect"), { code: "ECONNREFUSED" });
    const stand = api(() => Promise.reject(new TypeError("fetch failed", { cause })));
    const { checks } = await report({ fetch: stand.fetch });
    expect(checks.reachable).toMatchObject({ status: "fail", message: "Could not reach https://api.haau3.com (ECONNREFUSED). Check the network, a proxy or a firewall." });
    expect(checks["key-works"]).toMatchObject({ status: "skip", details: { waitsOn: "reachable" } });
    expect(stand.sent).toHaveLength(1);
  });

  it("fails when /health is not the API's", async () => {
    const { checks } = await report({ fetch: api((url) => (url.pathname === "/health" ? json(404, {}) : healthy(url))).fetch });
    expect(checks.reachable.status).toBe("fail");
    expect(checks.reachable.message).toBe("https://api.haau3.com answered /health with 404, so this may not be the haau3 API.");
  });
});

describe("env-file-ignored", () => {
  beforeEach(() => {
    write("package.json", JSON.stringify({ name: "app" }));
    write(".env", `HAAU3_API_KEY=${LIVE}\n`);
  });

  it("fails when git does not ignore the file, with the line to add, as keys create refuses", async () => {
    git("init", "-q");
    const { checks } = await report();
    expect(checks["env-file-ignored"]).toMatchObject({ status: "fail", details: { file: ".env", gitignore: { file: ".gitignore", line: ".env" } } });
    expect(checks["env-file-ignored"].message).toBe("git does not ignore .env, so the key could be committed. Add this line to .gitignore:\n  .env");
  });

  it("fails when git tracks it, with git rm --cached and what to do about a pushed key", async () => {
    git("init", "-q");
    git("add", ".env");
    const { checks } = await report();
    expect(checks["env-file-ignored"].status).toBe("fail");
    expect(checks["env-file-ignored"].message).toContain("git tracks .env, so the key is committed with it.");
    expect(checks["env-file-ignored"].message).toContain("revoke the key on the keys page");
    expect(checks["env-file-ignored"].next[0]!.command).toBe("git rm --cached -- .env");
  });

  it("passes when git ignores it, and skips outside a repository", async () => {
    expect((await report()).checks["env-file-ignored"]).toMatchObject({ status: "skip", details: { git: "no-repository" } });
    git("init", "-q");
    write(".gitignore", ".env\n");
    expect((await report()).checks["env-file-ignored"]).toMatchObject({ status: "pass", message: "git ignores .env." });
  });

  it("puts a multi-line message's lines under its first, at a terminal", async () => {
    git("init", "-q");
    const out = await doctor({ tty: true });
    expect(out.stdout).toContain("  fail  env-file-ignored  git does not ignore .env, so the key could be committed. Add this line to .gitignore:\n                            .env\n");
  });
});

describe("near-miss", () => {
  beforeEach(() => nodeProject());

  it("names a variable named like a key, or holding one, and never its value", async () => {
    write(".env", `HAAU3_TEST_API_KEY=${NEAR}\n`);
    const { checks } = await report();
    expect(checks["near-miss"]).toMatchObject({ status: "warn", details: { variables: [{ name: "HAAU3_TEST_API_KEY", source: ".env", by: "value" }], count: 1 } });
    expect(checks["near-miss"].message).toBe(
      "HAAU3_TEST_API_KEY in .env holds what looks like a haau3 key. The SDK reads only HAAU3_API_KEY: rename it to HAAU3_API_KEY, or remove it.",
    );
    const other = await report({ env: { MY_SERVICE_TOKEN: `Bearer ${NEAR}`, HAAU3_LIVE_API_KEY: "x", HAAU3_KEY_ID: "x", HAAU3_WEBHOOK_SIGNING_KEY: "x" } });
    expect(other.checks["near-miss"].details).toMatchObject({ count: 3 });
  });

  it("does not print a name that holds a key, and says the extra variable is unused beside a real key", async () => {
    write(".env.local", `HAAU3_API_KEY=${LIVE}\n`);
    write(".env", `${NEAR}=1\n`);
    const { checks } = await report();
    expect(checks["near-miss"].details).toMatchObject({ variables: [{ name: null, source: ".env", by: "name" }] });
    expect(checks["near-miss"].message).toContain("whose name haau3 does not print");
    expect(checks["near-miss"].message).toContain("so it is unused unless your own code reads it.");
  });

  it("leaves HAAU3_API_KEY itself alone", async () => {
    write(".env.local", `HAAU3_API_KEY=${LIVE}\n`);
    expect((await report()).checks["near-miss"]).toMatchObject({ status: "pass", details: { variables: [] } });
  });
});

describe("sdk and node", () => {
  it("warns when the installed SDK is older than the one in which the key's mode picks the host", async () => {
    nodeProject({ sdk: "^0.3.9", installed: "0.3.9" });
    write(".env", `HAAU3_API_KEY=${LIVE}\n`);
    const { checks } = await report();
    expect(checks.sdk).toMatchObject({ status: "warn", next: [{ command: "npm install @haau3/sdk@latest" }] });
    expect(checks.sdk.message).toContain("@haau3/sdk 0.3.9 in package.json is older than the first version in which the key's mode picks the host (0.4.0)");
  });

  it("goes by the installed version over the range, and by the range when nothing is installed", async () => {
    nodeProject({ sdk: "^0.3.9", installed: "0.4.1" });
    expect((await report()).checks.sdk.status).toBe("pass");
    nodeProject({ sdk: "^0.3.9", installed: null });
    rmSync(join(project, "node_modules"), { recursive: true, force: true });
    expect((await report()).checks.sdk.status).toBe("warn");
  });

  it("reads Python's and Go's own files, and runs nothing", async () => {
    for (const [file, text, status] of [
      ["requirements.txt", "requests==2.32\nhaau3==0.3.9  # pinned\n", "warn"],
      ["requirements.txt", "haau3>=0.4.0\n", "pass"],
      ["pyproject.toml", '[project]\ndependencies = ["httpx>=0.27", "haau3[extra]>=0.4.1; python_version>\'3.9\'"]\n', "pass"],
      ["pyproject.toml", '[tool.poetry.dependencies]\nhaau3 = "^0.3.0"\n', "warn"],
      ["Pipfile", '[packages]\nhaau3 = "==0.4.1"\n', "pass"],
      ["go.mod", "module example.com/app\n\nrequire (\n\tgithub.com/haau3/haau3-go v0.2.9\n)\n", "warn"],
      ["go.mod", "module example.com/app\n\nrequire github.com/haau3/haau3-go v0.3.1\n", "pass"],
    ] as const) {
      rmSync(project, { recursive: true, force: true });
      mkdirSync(project);
      write(file, text);
      const { checks } = await report();
      expect(checks.sdk.status, `${file}: ${text}`).toBe(status);
      expect(checks.node.status).toBe("skip");
    }
  });

  it("does not take haau3x for haau3, and warns with the install line when no SDK is named", async () => {
    write("requirements.txt", "haau3x==1.0\n");
    const { checks } = await report();
    expect(checks.sdk).toMatchObject({ status: "warn", next: [{ command: "pip install haau3" }] });
    rmSync(join(project, "requirements.txt"));
    expect((await report()).checks.sdk).toMatchObject({ status: "warn", next: [{ command: "npm install @haau3/sdk" }] });
  });

  it("fails node when the installed SDK needs a newer Node", async () => {
    nodeProject({ engines: ">=99" });
    const { checks } = await report();
    expect(checks.node).toMatchObject({ status: "fail", details: { required: 99 } });
  });
});

describe("signed-in", () => {
  const session = (expiresAt: number): StoredRecord => ({
    session: {
      accessToken: ACCESS_TOKEN,
      expiresAt: new Date(expiresAt).toISOString(),
      issuer: `${PLATFORM}/issuer`,
      clientId: "client_1",
      revocationEndpoint: `${PLATFORM}/issuer/revoke`,
      member: { id: "user_1", email: "dev@example.com" },
      organization: { id: "org_1", name: "Example Org", slug: null },
    },
  });

  beforeEach(() => {
    nodeProject();
    write(".env.local", `HAAU3_API_KEY=${LIVE}\n`);
  });

  it("names the member and organization from the stored session, and asks the platform nothing", async () => {
    const clock = fakeClock();
    const keyring = memoryKeyring();
    keyring.entries.set(PLATFORM, JSON.stringify(session(clock.now() + 30 * 60_000)));
    const stand = api();
    const { checks } = await report({ keyring, clock, fetch: stand.fetch });
    expect(checks["signed-in"]).toMatchObject({ status: "pass", details: { signedIn: true, organization: { name: "Example Org" } } });
    expect(checks["signed-in"].message).toMatch(/^Signed in as dev@example\.com in Example Org, until /);
    expect(stand.sent.every((s) => s.url.origin !== PLATFORM)).toBe(true);
  });

  it("says a session has ended, without revoking anything", async () => {
    const clock = fakeClock();
    const keyring = memoryKeyring();
    keyring.entries.set(PLATFORM, JSON.stringify(session(clock.now() - 60_000)));
    const { checks } = await report({ keyring, clock });
    expect(checks["signed-in"].message).toContain("Not signed in: the session ended at");
    expect(keyring.entries.has(PLATFORM)).toBe(true);
  });

  it("says when the credential store could not be reached, rather than signed out", async () => {
    const { checks } = await report({ keyring: unreachableKeyring() });
    expect(checks["signed-in"].message).toContain("The system's credential store could not be reached");
  });
});

describe("keys create's next step", () => {
  it("is doctor, with --file when the key went to a file doctor does not read by default", async () => {
    const { doctorStep } = await import("../src/commands/context.js");
    expect(doctorStep().command).toBe("npx haau3 doctor");
    expect(doctorStep("config/my env.env").command).toBe("npx haau3 doctor --file 'config/my env.env'");
    // A file whose name starts with a dash is given with = so it is not read as a flag.
    expect(doctorStep("-x.env").command).toBe("npx haau3 doctor --file=-x.env");
  });
});

// --- what the adversarial review found (2026-11-12) -----------------------------------------------

describe("where a key may go (owner, 2026-11-12)", () => {
  it("never to a host that is neither haau3's nor this computer, as a committed .env could name: /health is asked with no key", async () => {
    nodeProject();
    write(".env", "HAAU3_BASE_URL=https://evil.example\n");
    const stand = api();
    const { out, document, checks } = await report({ env: { HAAU3_API_KEY: LIVE }, fetch: stand.fetch });
    expect(stand.sent.map((s) => `${s.url.origin}${s.url.pathname}`)).toEqual(["https://evil.example/health"]);
    expect(stand.sent[0]!.headers.has("authorization")).toBe(false);
    expect(checks.settings).toMatchObject({ status: "warn", details: { keySent: false } });
    expect(checks.settings.message).toContain("which is neither haau3's own address nor this computer. haau3 sends a key only to those");
    expect(checks["key-works"]).toMatchObject({ status: "skip", details: { waitsOn: "settings" } });
    expect(document.data.baseURL).toBe("https://evil.example");
    expect(out.stdout).not.toContain("The API took the key");
  });

  it("to this computer, where a stand-in's answer is reported as its own and not as haau3's", async () => {
    nodeProject();
    write(".env", `HAAU3_API_KEY=${LIVE}\nHAAU3_BASE_URL=http://127.0.0.1:3001\n`);
    const stand = api();
    const { checks } = await report({ fetch: stand.fetch });
    expect(stand.sent.map((s) => s.headers.get("authorization"))).toEqual([`Bearer ${LIVE}`, `Bearer ${LIVE}`]);
    expect(checks["key-works"].status).toBe("warn");
    expect(checks["key-works"].message).toMatch(/^http:\/\/127\.0\.0\.1:3001 answered metadata in \d+ ms\. It is not production's own address, so the key is not proven at haau3\.$/);
  });

  it("asks a stand-in with no /health for metadata anyway, since it answered", async () => {
    nodeProject();
    write(".env", `HAAU3_API_KEY=${LIVE}\nHAAU3_BASE_URL=http://localhost:3001\n`);
    const { checks } = await report({ fetch: api((url) => (url.pathname === "/health" ? json(404, {}) : healthy(url))).fetch });
    expect(checks.reachable.status).toBe("warn");
    expect(checks["key-works"].status).toBe("warn");
  });
});

describe("a base URL as printed", () => {
  it("is its origin, with /… for a path that could hold a gateway's token", async () => {
    nodeProject();
    write(".env", `HAAU3_API_KEY=${LIVE}\nHAAU3_BASE_URL=http://localhost:3001/t/PATHSECRET123\n`);
    const stand = api();
    const { out, document } = await report({ fetch: stand.fetch });
    expect(out.stdout).not.toContain("PATHSECRET123");
    expect(document.data.baseURL).toBe("http://localhost:3001/…");
    expect(stand.sent[0]!.url.pathname).toBe("/t/PATHSECRET123/health");
    expect(shownBase("https://api.haau3.com")).toBe("https://api.haau3.com");
  });

  it("is refused when a key is split across a line break, which the URL parser removes", async () => {
    nodeProject();
    write(".env", `HAAU3_API_KEY=${LIVE}\nHAAU3_BASE_URL="https://api.example.com/haau3_\\nsk_${LIVE.slice(9)}"\n`);
    const stand = api();
    const { out, checks } = await report({ fetch: stand.fetch });
    expect(checks.settings.message).toContain("holds what looks like an API key");
    expect(stand.sent).toEqual([]);
    expect(out.stdout).not.toContain(LIVE.slice(14, 30));
  });
});

describe("settings an application reads first", () => {
  it("stops at a variable set but empty in the shell, which hides the file's value, as applications' loaders do", async () => {
    nodeProject();
    write(".env", `HAAU3_API_KEY=${LIVE}\n`);
    const empty = await report({ env: { HAAU3_API_KEY: "" } });
    expect(empty.checks.key.status).toBe("fail");
    expect(empty.checks.key.message).toContain("HAAU3_API_KEY is set but empty in the environment, which hides any value a later file gives it");
    write(".env", `HAAU3_API_KEY=${LIVE}\nHAAU3_ENVIRONMENT=sandbox\nHAAU3_BASE_URL=https://proxy.example\n`);
    const stand = api();
    const environment = await report({ env: { HAAU3_ENVIRONMENT: "", HAAU3_BASE_URL: "" }, fetch: stand.fetch });
    expect(environment.document.environment).toBe("production");
    expect(new Set(stand.sent.map((s) => s.url.origin))).toEqual(new Set([PRODUCTION]));
  });

  it("refuses an environment that is only spaces, as the SDK does", async () => {
    nodeProject();
    write(".env", `HAAU3_API_KEY=${TEST}\nHAAU3_ENVIRONMENT=sandbox\n`);
    const { checks } = await report({ env: { HAAU3_ENVIRONMENT: "  " } });
    expect(checks.settings.message).toBe("HAAU3_ENVIRONMENT in the environment is neither production nor sandbox.");
  });

  it("names the base URL as the reason when it sets the address", async () => {
    nodeProject();
    write(".env", `HAAU3_API_KEY=${LIVE}\nHAAU3_BASE_URL=https://api.haau3.com\n`);
    const { checks } = await report();
    expect(checks.settings.message).toBe("The SDK calls production at https://api.haau3.com: HAAU3_BASE_URL in .env names its address.");
  });
});

describe("with no key", () => {
  it("checks /health where HAAU3_BASE_URL in a file says, never the shell's own read of it", async () => {
    nodeProject();
    write(".env", "HAAU3_BASE_URL=http://localhost:4010\n");
    const stand = api();
    await report({ fetch: stand.fetch });
    expect(stand.sent.map((s) => `${s.url.origin}${s.url.pathname}`)).toEqual(["http://localhost:4010/health"]);
  });

  it("calls nothing when production is named, since production takes no call without a key", async () => {
    nodeProject();
    const stand = api();
    const { checks } = await report({ env: { HAAU3_ENVIRONMENT: "production" }, fetch: stand.fetch });
    expect(checks.reachable).toMatchObject({ status: "skip", details: { waitsOn: "key" } });
    expect(stand.sent).toEqual([]);
  });
});

describe("/health's own answers", () => {
  beforeEach(() => {
    nodeProject();
    write(".env.local", `HAAU3_API_KEY=${LIVE}\n`);
  });

  it("429 is a warning, and metadata waits", async () => {
    const { out, checks } = await report({ fetch: api((url) => (url.pathname === "/health" ? json(429, {}) : healthy(url))).fetch });
    expect(out.code).toBe(0);
    expect(checks.reachable.status).toBe("warn");
    expect(checks["key-works"]).toMatchObject({ status: "skip", details: { waitsOn: "reachable" } });
  });

  it("503 is a fail with the cold-start note", async () => {
    const { checks } = await report({ fetch: api((url) => (url.pathname === "/health" ? json(503, {}) : healthy(url))).fetch });
    expect(checks.reachable.status).toBe("fail");
    expect(checks.reachable.message).toContain("An instance of the API may have been starting");
  });
});

describe("what a hostile or broken answer cannot get printed", () => {
  beforeEach(() => {
    nodeProject();
    write(".env.local", `HAAU3_API_KEY=${LIVE}\n`);
  });

  it("a 403 code is named only when doctor knows it, and never when it holds part of the key", async () => {
    // Codes are lower case, so the stolen part is from the key's lower-case run.
    const stolen = LIVE.slice(30, 46);
    for (const [code, named, kept] of [
      ["phi-agreement-required", true, true],
      ["some-new-code", false, true],
      [`x-${stolen}`, false, false],
    ] as const) {
      const { checks } = await report({ fetch: api(metadata(() => fhir(403, outcome("forbidden", code)))).fetch });
      expect(checks["key-works"].message.includes(code)).toBe(named);
      expect((checks["key-works"].details.problem as { code?: string }).code === code).toBe(kept);
    }
  });

  it("a Retry-After past a day is not repeated", async () => {
    const { out, checks } = await report({ fetch: api(metadata(() => fhir(429, outcome("throttled"), { "retry-after": "9".repeat(400) }))).fetch });
    expect(checks["key-works"]).toMatchObject({ status: "warn", details: { retryAfter: null } });
    expect(out.stdout).not.toContain("Infinity");
  });

  it("a stored session's name that holds its token, or a key, is left out", async () => {
    const clock = fakeClock();
    const keyring = memoryKeyring();
    keyring.entries.set(
      PLATFORM,
      JSON.stringify({
        session: {
          accessToken: ACCESS_TOKEN,
          expiresAt: new Date(clock.now() + 30 * 60_000).toISOString(),
          issuer: `${PLATFORM}/issuer`,
          clientId: "client_1",
          revocationEndpoint: `${PLATFORM}/issuer/revoke`,
          member: { id: "user_1", email: `x${LIVE}@example.com` },
          organization: { id: "org_1", name: `Org ${ACCESS_TOKEN}`, slug: null },
        },
      } satisfies StoredRecord),
    );
    const { checks } = await report({ keyring, clock });
    expect(checks["signed-in"]).toMatchObject({ status: "pass", details: { organization: { name: null } } });
    expect(checks["signed-in"].message).toMatch(/^Signed in, until /);
  });

  it("key-works keeps why there was no answer, as reachable does", async () => {
    const cause = Object.assign(new Error("x"), { code: "ECONNRESET" });
    const { checks } = await report({ fetch: api(metadata(() => Promise.reject(new TypeError("fetch failed", { cause })))).fetch });
    expect(checks["key-works"].details).toMatchObject({ reason: "network", detail: "ECONNRESET" });
  });
});

describe("the session's two stores", () => {
  it("are read, never reconciled: doctor ends no grant and changes neither store", async () => {
    nodeProject();
    write(".env.local", `HAAU3_API_KEY=${LIVE}\n`);
    const clock = fakeClock();
    const record = (email: string, minutes: number): StoredRecord => ({
      session: {
        accessToken: `${ACCESS_TOKEN}${minutes}`,
        expiresAt: new Date(clock.now() + minutes * 60_000).toISOString(),
        issuer: `${PLATFORM}/issuer`,
        clientId: "client_1",
        revocationEndpoint: `${PLATFORM}/issuer/revoke`,
        member: { id: "user_1", email },
        organization: { id: "org_1", name: "Example Org", slug: null },
      },
    });
    const keyring = memoryKeyring();
    keyring.entries.set(PLATFORM, JSON.stringify(record("keyring@example.com", 10)));
    const fileOnly = testStore(dir, memoryKeyring(), { HAAU3_SESSION_STORE: "file" });
    const { fromStored } = await import("../src/session/record.js");
    await fileOnly.save(PLATFORM, fromStored(record("file@example.com", 50), PLATFORM));
    const keyringBefore = keyring.entries.get(PLATFORM);
    const { checks } = await report({ keyring, clock });
    expect(checks["signed-in"].message).toMatch(/^Signed in as file@example\.com in Example Org/);
    expect(keyring.entries.get(PLATFORM)).toBe(keyringBefore);
    expect((await fileOnly.load(PLATFORM)).record.session?.member.email).toBe("file@example.com");
  });
});

describe("paths and steps", () => {
  it("a requirements file whose name holds a key is not read, so never named", async () => {
    write(["requirements", LIVE, "txt"].join("-").replace(/-txt$/, ".txt"), "haau3==0.3.0\n");
    const { out, checks } = await report();
    expect(checks.sdk.details).toMatchObject({ sdks: [] });
    expect(out.stdout).not.toContain("DOCTORLIVE");
  });

  it("a --file outside the folder is printed as it was given, never with the folders above it", async () => {
    const parent = mkdtempSync(join(tmpdir(), "cli-doctor-parent-"));
    try {
      const odd = join(parent, process.platform === "win32" ? "odd folder" : "odd\u001b[2Jfolder");
      mkdirSync(join(odd, "app"), { recursive: true });
      writeFileSync(join(odd, "outside.env"), `HAAU3_API_KEY=${LIVE}\n`);
      const out = await runCli(["doctor", "--file", "../outside.env"], {
        tty: true,
        env: cleanEnv({ HAAU3_PLATFORM_URL: PLATFORM }),
        cwd: join(odd, "app"),
        io: { fetch: api().fetch, store: testStore(dir, memoryKeyring()), ...fakeClock() },
      });
      expect(out.stdout).toContain("HAAU3_API_KEY in ../outside.env: a live key");
      expect(out.stdout).not.toContain("\u001b");
      expect(out.stdout).not.toContain(parent);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("a file whose name starts with a dash is given as --file=, and git rm stops reading flags first", async () => {
    write("package.json", JSON.stringify({ name: "app" }));
    write("-x.env", `HAAU3_API_KEY=${LIVE}\n`);
    git("init", "-q");
    git("add", "--", "-x.env");
    const { checks } = await report({ args: ["--file=-x.env"], fetch: api(() => Promise.reject(new TypeError("fetch failed"))).fetch });
    expect(checks["env-file-ignored"].next[0]!.command).toBe("git rm --cached -- -x.env");
    expect(checks.reachable.next[0]!.command).toBe("npx haau3 doctor --file=-x.env");
  });

  it("a failing run at a terminal also lists the warnings' steps", async () => {
    nodeProject({ sdk: "^0.3.9", installed: "0.3.9" });
    const out = await doctor({ tty: true });
    expect(out.code).toBe(1);
    expect(out.stdout).toContain("For the warnings:\n  npm install @haau3/sdk@latest\n");
  });

  it("two near-misses read as one sentence", async () => {
    nodeProject();
    write(".env", `HAAU3_TEST_API_KEY=${NEAR}\nOTHER_KEY_VALUE=${NEAR}\n`);
    const { checks } = await report();
    expect(checks["near-miss"].message).toBe(
      "HAAU3_TEST_API_KEY in .env holds what looks like a haau3 key, and 1 more variable does the same. The SDK reads only HAAU3_API_KEY: rename it to HAAU3_API_KEY, or remove it.",
    );
  });
});

// --- the file-reading review (2026-11-12) -----------------------------------------------------------

describe("every file that holds a key is asked about, not only the one in use", () => {
  it("fails on a tracked .env holding a live key, though the key in use is .env.local's", async () => {
    nodeProject();
    write(".gitignore", ".env.local\nnode_modules\n");
    write(".env.local", `HAAU3_API_KEY=${TEST}\n`);
    write(".env", `HAAU3_API_KEY=${LIVE}\n`);
    git("add", ".env");
    const { checks } = await report();
    expect(checks.key.details).toMatchObject({ source: ".env.local" });
    expect(checks["env-file-ignored"]).toMatchObject({ status: "fail", details: { file: ".env", git: "not-ignored" } });
    expect(checks["env-file-ignored"].message).toContain("git tracks .env");
  });

  it("asks about a key under another name too, with the key in use from the shell", async () => {
    nodeProject();
    write(".gitignore", "node_modules\n");
    write(".env", `MY_OLD_KEY=${NEAR}\n`);
    const { checks } = await report({ env: { HAAU3_API_KEY: LIVE } });
    expect(checks["env-file-ignored"]).toMatchObject({ status: "fail", details: { file: ".env" } });
  });
});

describe("the files a project's loader reads (owner, 2026-11-12)", () => {
  it("reads .env alone outside Next.js and Vite, and says a key in .env.local is not loaded", async () => {
    nodeProject({ framework: false });
    write(".env.local", `HAAU3_API_KEY=${TEST}\n`);
    write(".env", `HAAU3_API_KEY=${LIVE}\n`);
    const both = await report();
    expect(both.checks.key).toMatchObject({ status: "warn", details: { source: ".env", mode: "live" } });
    expect(both.checks.key.message).toContain(".env.local also holds a key, which this project's loader does not read: only Next.js and Vite load it.");
    rmSync(join(project, ".env"));
    const onlyLocal = await report();
    expect(onlyLocal.checks.key).toMatchObject({ status: "fail", details: { unloaded: ".env.local" } });
    expect(onlyLocal.checks.key.message).toContain("HAAU3_API_KEY is in .env.local, which this project's loader does not read");
  });
});

describe("what Node's parser does not read", () => {
  it("warns when the key is on a first line after a byte-order mark, which Node and Vite skip", async () => {
    nodeProject();
    write(".env", `\uFEFFHAAU3_API_KEY=${LIVE}\n`);
    const { checks } = await report();
    expect(checks.key.status).toBe("warn");
    expect(checks.key.message).toContain("starts with a byte-order mark");
  });

  it("names a key line Node's parser skips, rather than saying there is none", async () => {
    nodeProject();
    write(".env", `HAAU3_API_KEY: ${LIVE}\n`);
    const { checks } = await report();
    expect(checks.key.status).toBe("fail");
    expect(checks.key.message).toContain(".env has a HAAU3_API_KEY line that Node's parser does not read");
  });

  it("says a UTF-16 file is not UTF-8 text", async () => {
    nodeProject();
    writeFileSync(join(project, ".env"), Buffer.from(`\uFEFFHAAU3_API_KEY=${LIVE}\n`, "utf16le"));
    const { checks } = await report();
    expect(checks.key.message).toContain(".env is not UTF-8 text, as UTF-16 is not");
  });
});

describe("near-miss, as the review found them", () => {
  it("catches a key behind Bearer and a key alone on a line, and leaves other HAAU3 settings alone", async () => {
    nodeProject();
    write(".env", `API_TOKEN=Bearer ${NEAR}\n${NEAR}\nHAAU3_KEY_ID=k1\nHAAU3_KEYRING_BACKEND=file\n`);
    const { checks } = await report();
    const found = checks["near-miss"].details.variables as { name: string | null; by: string }[];
    expect(found).toEqual([
      { name: null, source: ".env", by: "value" },
      { name: "API_TOKEN", source: ".env", by: "value" },
    ]);
  });
});

describe("steps a shell runs as printed", () => {
  it("git rm runs in the file's own folder, for a --file outside this one", async () => {
    nodeProject();
    mkdirSync(join(project, "config"));
    git("-C", "config", "init", "-q");
    write("config/prod.env", `HAAU3_API_KEY=${LIVE}\n`);
    execFileSync("git", ["-C", join(project, "config"), "add", "prod.env"], { stdio: "ignore" });
    const { checks } = await report({ args: ["--file", "config/prod.env"] });
    expect(checks["env-file-ignored"].next[0]!.command).toBe("git -C config rm --cached -- prod.env");
  });

  it("quotes a backslash and a leading ~ on POSIX, where a shell reads them", async () => {
    const { arg } = await import("../src/commands/context.js");
    expect(arg("my\\.env", "linux")).toBe("'my\\.env'");
    expect(arg("~/x.env", "linux")).toBe("'~/x.env'");
    expect(arg("a~b.env", "linux")).toBe("a~b.env");
    expect(arg("C:\\app\\.env", "win32")).toBe("C:\\app\\.env");
  });
});
