// The request id the platform puts on every answer, kept on every error the command line builds from
// one, a success it cannot use included; and never taken from the sign-in service's answers, whose id
// would not be the platform's.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { discover } from "../src/signin/discovery.js";
import { problemOf } from "../src/signin/http.js";
import { FakeServer, NEW_KEY_MARKERS, PLATFORM_REQUEST_ID, SIGN_IN_SERVICE_REQUEST_ID, type TokenAnswer } from "./fake-server.js";
import { cleanEnv, fakeClock, memoryKeyring, runCli, testStore } from "./helpers.js";

let server: FakeServer;
let dir: string;
let project: string;
let keyring: ReturnType<typeof memoryKeyring>;
let clock: ReturnType<typeof fakeClock>;

beforeEach(async () => {
  server = await new FakeServer().start();
  dir = mkdtempSync(join(tmpdir(), "cli-request-id-store-"));
  project = mkdtempSync(join(tmpdir(), "cli-request-id-project-"));
  keyring = memoryKeyring();
  clock = fakeClock();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await server.stop();
  rmSync(dir, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

/** Runs the command line in the project, against the stand-in, with no terminal. */
function cli(args: string[]) {
  const env = cleanEnv({ HAAU3_PLATFORM_URL: server.url });
  return runCli(args, { env, cwd: project, io: { store: testStore(dir, keyring, env), now: clock.now, sleep: clock.sleep } });
}

const json = (text: string) => JSON.parse(text);

async function signIn() {
  await cli(["login"]);
  expect((await cli(["login", "--complete"])).code).toBe(0);
}

/** What a success the command line cannot use gives: its status and the platform's request id. */
const success = (status: number) => ({ type: "about:blank", title: `HTTP ${status}`, status, requestId: PLATFORM_REQUEST_ID });

/** The platform's 404 while signing in from the command line is off, as it answered. */
const OFF = { type: "about:blank", title: "Refused", status: 404, code: "not-found", requestId: PLATFORM_REQUEST_ID };

/** Throws, without repeating it, when `text` holds any part of the new key past its prefix. */
function assertNoKey(text: string) {
  const hit = NEW_KEY_MARKERS.findIndex((m) => text.includes(m));
  if (hit !== -1) throw new Error(`printed new-key marker number ${hit}`);
}

describe("every error built from the platform's answer carries its request id", () => {
  it("login while signing in from the command line is off: the 404's own problem", async () => {
    server.platformMetadata = "off";
    const out = await cli(["login"]);
    expect(out.code).toBe(1);
    const { error } = json(out.stdout);
    expect(error.code).toBe("sign-in-unavailable");
    expect(error.problem).toEqual(OFF);
  });

  it.each([
    [
      "for another resource",
      () => {
        server.platformMetadata = "other-resource";
      },
    ],
    [
      "naming no client id",
      () => {
        server.platformMetadata = "no-client-id";
      },
    ],
    [
      "naming a scope haau3 cannot ask for",
      () => {
        server.scopes = ["user:org:read", "two words"];
      },
    ],
  ])("login refusing sign-in details %s: the 200's status and id", async (_, arrange) => {
    arrange();
    const out = await cli(["login"]);
    expect(out.code).toBe(1);
    const { error } = json(out.stdout);
    expect(error.code).toBe("unexpected-answer");
    expect(error.problem).toEqual(success(200));
    expect(server.to("/issuer/device")).toHaveLength(0);
  });

  it("login refusing a sign-in service outside haau3.com, which only haau3's own platform checks: the 200's status and id", async () => {
    // The check applies only to https://platform.haau3.com, so its one answer is played here instead.
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            resource: "https://platform.haau3.com/api/cli/v1",
            authorization_servers: ["https://sign-in.example.com"],
            haau3_client_id: "client_fake",
            scopes_supported: ["user:org:read"],
          }),
          { status: 200, headers: { "Content-Type": "application/json", "X-Request-Id": PLATFORM_REQUEST_ID } },
        ),
    );
    vi.stubGlobal("fetch", fetch);
    const result = await discover("https://platform.haau3.com");
    expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: "unexpected-answer", message: "platform.haau3.com named a sign-in service outside haau3.com.", problem: success(200) }) });
    // Nothing was asked of the service it named.
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("whoami unable to read the platform's description of the session: the 200's status and id", async () => {
    await signIn();
    server.whoamiAnswer = "garbled";
    const out = await cli(["whoami"]);
    expect(out.code).toBe(1);
    const { error } = json(out.stdout);
    expect(error.code).toBe("unexpected-answer");
    expect(error.problem).toEqual(success(200));
  });

  it("login --complete unable to read it: the 200's status and id", async () => {
    server.whoamiAnswer = "garbled";
    await cli(["login"]);
    const out = await cli(["login", "--complete"]);
    expect(out.code).toBe(1);
    const { error } = json(out.stdout);
    expect(error.code).toBe("unexpected-answer");
    expect(error.problem).toEqual(success(200));
  });

  it("login --complete when the platform says the session has already ended: the 200's status and id", async () => {
    server.whoamiExpiresAt = new Date(Date.now() - 60 * 60_000).toISOString();
    await cli(["login"]);
    const out = await cli(["login", "--complete"]);
    expect(out.code).toBe(1);
    const { error } = json(out.stdout);
    expect(error.code).toBe("sign-in-refused");
    expect(error.message).toBe("The platform says this sign-in has already ended.");
    expect(error.problem).toEqual(success(200));
  });

  it.each([
    ["garbled", 201],
    ["ok-200", 200],
  ] as const)("keys create answered %s, a success it cannot use: its status and id", async (answer, status) => {
    await signIn();
    server.keysAnswer = answer;
    writeFileSync(join(project, ".env"), "PORT=3000\n");
    const out = await cli(["keys", "create"]);
    assertNoKey(out.stdout + out.stderr);
    const { error } = json(out.stdout);
    expect(error.code).toBe("unexpected-answer");
    expect(error.message).toContain("it may have made a key");
    expect(error.problem).toEqual(success(status));
  });

  it("keys create while signing in from the command line is off: the 404's own problem", async () => {
    await signIn();
    server.keysAnswer = "off";
    const { error } = json((await cli(["keys", "create"])).stdout);
    expect(error.code).toBe("sign-in-unavailable");
    expect(error.problem).toEqual(OFF);
  });

  it("keeps no request id that holds a key, from a success it cannot use", async () => {
    await signIn();
    server.keysAnswer = "key-in-request-id";
    writeFileSync(join(project, ".env"), "PORT=3000\n");
    const out = await cli(["keys", "create"]);
    assertNoKey(out.stdout + out.stderr);
    const { error } = json(out.stdout);
    expect(error.code).toBe("unexpected-answer");
    expect(error.problem).toEqual({ type: "about:blank", title: "HTTP 201", status: 201 });
  });
});

describe("the sign-in service's answers", () => {
  it.each([
    ["issuerMetadata", "other-issuer"],
    ["issuerMetadata", "foreign-endpoint"],
    ["issuerMetadata", "no-device-grant"],
    ["issuerMetadata", "missing"],
    ["deviceAnswer", "bad-code"],
    ["deviceAnswer", "invalid_client"],
  ] as const)("give login no problem, and never their request id: %s %s", async (field, value) => {
    (server as unknown as Record<string, string>)[field] = value;
    const out = await cli(["login"]);
    expect(out.code).toBe(1);
    expect(json(out.stdout).error.problem).toBeUndefined();
    expect(out.stdout).not.toContain(SIGN_IN_SERVICE_REQUEST_ID);
  });

  it.each(["denied", "expired", "invalid_grant"] as TokenAnswer[])("give login --complete no problem, and never their request id: a token answer %s", async (answer) => {
    server.tokenAnswers = [answer];
    await cli(["login"]);
    const out = await cli(["login", "--complete"]);
    expect(out.code).toBe(1);
    expect(json(out.stdout).error.problem).toBeUndefined();
    expect(out.stdout).not.toContain(SIGN_IN_SERVICE_REQUEST_ID);
  });
});

describe("a success or a redirect", () => {
  // Every member a problem has, in a body that is not one.
  const body = { type: "https://example.com/not-a-problem", title: "Looks like one", status: 418, code: "looks-like-one", detail: "Not a problem." };

  it.each([200, 201, 302])("keeps only its status and request id: HTTP %i", (status) => {
    expect(problemOf({ status, headers: new Headers({ "X-Request-Id": "req_123" }), body })).toEqual({ type: "about:blank", title: `HTTP ${status}`, status, requestId: "req_123" });
  });

  it("while a refusal's members are still read", () => {
    expect(problemOf({ status: 400, headers: new Headers({ "X-Request-Id": "req_123" }), body })).toEqual({
      type: "https://example.com/not-a-problem",
      title: "Looks like one",
      status: 400,
      code: "looks-like-one",
      requestId: "req_123",
    });
  });
});
