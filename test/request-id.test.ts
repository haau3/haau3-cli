// The request id the platform puts on every answer, kept on every error the command line builds from
// one, a success it cannot use included; and never taken from the sign-in service's answers, whose id
// would not be the platform's.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { discover } from "../src/signin/discovery.js";
import { problemOf } from "../src/signin/http.js";
import { ACCESS_TOKEN, FakeServer, NEW_KEY_MARKERS, newKey, PLATFORM_REQUEST_ID, SIGN_IN_SERVICE_REQUEST_ID, type TokenAnswer } from "./fake-server.js";
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

  it.each([
    ["whoami", "unauthorized", "session-ended", { title: "Refused", status: 401, code: "unauthorized" }],
    ["whoami", "not-a-member", "not-a-member", { title: "Refused", status: 403, code: "not-a-member" }],
    ["whoami", "refused", "unexpected-answer", { title: "Refused", status: 400, code: "invalid-request" }],
    ["whoami", "unavailable", "platform-unavailable", { title: "Refused", status: 503, code: "unavailable" }],
  ] as const)("%s answered %s: %s, with the refusal's own problem", async (_, answer, code, problem) => {
    await signIn();
    server.whoamiAnswer = answer;
    const { error } = json((await cli(["whoami"])).stdout);
    expect(error.code).toBe(code);
    expect(error.problem).toEqual({ type: "about:blank", ...problem, requestId: PLATFORM_REQUEST_ID });
  });

  it.each([
    ["unauthorized", "sign-in-refused", { title: "Refused", status: 401, code: "unauthorized" }],
    ["no-organization", "no-organization", { title: "Refused", status: 403, code: "no-organization" }],
  ] as const)("login --complete with whoami answering %s: %s, with the refusal's own problem", async (answer, code, problem) => {
    server.whoamiAnswer = answer;
    await cli(["login"]);
    const { error } = json((await cli(["login", "--complete"])).stdout);
    expect(error.code).toBe(code);
    expect(error.problem).toEqual({ type: "about:blank", ...problem, requestId: PLATFORM_REQUEST_ID });
  });

  it.each([
    ["unauthorized", "session-ended", { title: "Refused", status: 401, code: "unauthorized" }],
    ["not-a-member", "not-a-member", { title: "Refused", status: 403, code: "not-a-member" }],
    ["invalid-request", "unexpected-answer", { title: "Refused", status: 400, code: "invalid-request" }],
    ["unavailable", "platform-unavailable", { title: "Refused", status: 503, code: "unavailable" }],
  ] as const)("keys create answered %s: %s, with the refusal's own problem", async (answer, code, problem) => {
    await signIn();
    server.keysAnswer = answer;
    writeFileSync(join(project, ".env"), "PORT=3000\n");
    const { error } = json((await cli(["keys", "create"])).stdout);
    expect(error.code).toBe(code);
    expect(error.problem).toEqual({ type: "about:blank", ...problem, requestId: PLATFORM_REQUEST_ID });
  });

  it("login refused its sign-in details with another status: the refusal's own problem", async () => {
    server.platformMetadata = "refused";
    const { error } = json((await cli(["login"])).stdout);
    expect(error.code).toBe("unexpected-answer");
    expect(error.problem).toEqual({ type: "about:blank", title: "Refused", status: 403, code: "forbidden", requestId: PLATFORM_REQUEST_ID });
  });
});

describe("a request id that holds a secret is never kept", () => {
  const random = newKey("live").replace(/^haau3_sk_live_/, "");
  const token = ACCESS_TOKEN;

  it.each([
    ["the key", newKey("live")],
    ["the key's random part, without its marker", random],
    ["eight characters of it running", `req-${random.slice(6, 14)}`],
    ["the key in another form", `${["haau3", "sk", "live"].join(".")}.${random}`],
  ])("keys create answered a success it cannot use with %s as its request id", async (_, requestId) => {
    await signIn();
    server.keysAnswer = "garbled";
    server.platformRequestId = requestId;
    writeFileSync(join(project, ".env"), "PORT=3000\n");
    const out = await cli(["keys", "create"]);
    assertNoKey(out.stdout + out.stderr);
    expect(out.stdout).not.toContain(requestId);
    expect(json(out.stdout).error.problem).toEqual({ type: "about:blank", title: "HTTP 201", status: 201 });
  });

  it.each([
    ["the session's token", token],
    ["eight characters of it running", `req-${token.slice(8, 16)}`],
  ])("keys create, whoami and login --complete given %s as a request id", async (_, requestId) => {
    // A success it cannot use, and a refusal: each built from an answer to a request that sent the token.
    await signIn();
    server.platformRequestId = requestId;
    server.keysAnswer = "garbled";
    writeFileSync(join(project, ".env"), "PORT=3000\n");
    const keys = await cli(["keys", "create"]);
    server.whoamiAnswer = "garbled";
    const whoami = await cli(["whoami"]);
    // Each refusal ends the session, so each is asked of a new one.
    server.keysAnswer = "not-a-member";
    const refused = await cli(["keys", "create"]);
    server.whoamiAnswer = "ok";
    await signIn();
    server.whoamiAnswer = "unauthorized";
    const ended = await cli(["whoami"]);
    for (const out of [keys, whoami, refused, ended]) {
      expect(out.stdout + out.stderr).not.toContain(requestId);
      expect(json(out.stdout).error.problem).toBeDefined();
      expect(json(out.stdout).error.problem.requestId).toBeUndefined();
    }

    server.platformRequestId = PLATFORM_REQUEST_ID;
    server.whoamiAnswer = "ok";
    server.whoamiExpiresAt = new Date(Date.now() - 60 * 60_000).toISOString();
    await cli(["login"]);
    server.platformRequestId = requestId;
    const late = await cli(["login", "--complete"]);
    expect(late.stdout).not.toContain(requestId);
    expect(json(late.stdout).error).toMatchObject({ code: "sign-in-refused", problem: { type: "about:blank", title: "HTTP 200", status: 200 } });
    expect(json(late.stdout).error.problem.requestId).toBeUndefined();
  });

  it("login, with a key's marker in the sign-in details' request id", async () => {
    server.platformMetadata = "other-resource";
    server.platformRequestId = newKey("test");
    const out = await cli(["login"]);
    expect(out.stdout).not.toContain(newKey("test"));
    expect(json(out.stdout).error.problem).toEqual({ type: "about:blank", title: "HTTP 200", status: 200 });
  });
});

describe("the sign-in service's answers", () => {
  it.each([
    ["issuerMetadata", "other-issuer"],
    ["issuerMetadata", "foreign-endpoint"],
    ["issuerMetadata", "no-device-grant"],
    ["issuerMetadata", "missing"],
    ["issuerMetadata", "server-error"],
    ["deviceAnswer", "bad-code"],
    ["deviceAnswer", "invalid_client"],
    ["deviceAnswer", "server-error"],
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

  it.each([200, 201, 202, 204, 301, 302, 304, 399])("keeps only its status and request id: HTTP %i", (status) => {
    expect(problemOf({ status, headers: new Headers({ "X-Request-Id": "req_123" }), body })).toEqual({ type: "about:blank", title: `HTTP ${status}`, status, requestId: "req_123" });
  });

  it.each([400, 404, 500])("while a refusal's members are still read: HTTP %i", (status) => {
    expect(problemOf({ status, headers: new Headers({ "X-Request-Id": "req_123" }), body })).toEqual({
      type: "https://example.com/not-a-problem",
      title: "Looks like one",
      status,
      code: "looks-like-one",
      requestId: "req_123",
    });
  });
});

describe("a request id", () => {
  const idOf = (requestId: string) => problemOf({ status: 200, headers: new Headers({ "X-Request-Id": requestId }), body: undefined }).requestId;

  it("is kept up to 100 characters, and not past them", () => {
    expect(idOf("a".repeat(100))).toBe("a".repeat(100));
    expect(idOf("a".repeat(101))).toBeUndefined();
  });

  it("is kept with letters, digits and . : _ - only", () => {
    expect(idOf("f4a8f8cf-2df6-41d2-ac99-5a589fc11714")).toBe("f4a8f8cf-2df6-41d2-ac99-5a589fc11714");
    expect(idOf("req_1.a:b")).toBe("req_1.a:b");
    for (const other of ["a/b", "a=b", "a+b", "a b", "a;b", "a<b", "a\"b", "a%20"]) expect(idOf(other)).toBeUndefined();
  });

  it("is dropped when it holds a key's marker, in any case", () => {
    expect(idOf(["HAAU3", "SK", "x"].join("_"))).toBeUndefined();
    expect(idOf(`req-${["haau3", "sk", "x"].join("_")}`)).toBeUndefined();
  });
});
