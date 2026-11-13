// haau3 login, whoami and logout against a stand-in platform and sign-in service: every answer RFC
// 8628 names, every refusal the platform gives, with no terminal and at one, as JSON and as text.
// The clock is fake, so a test that polls for minutes takes none.
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { COMPLETE_WAIT_MS } from "../src/commands/login.js";
import { POLL_TIMEOUT_MS } from "../src/signin/device.js";
import { keyringName } from "../src/session/keyring.js";
import { VERSION } from "../src/version.js";
import { ACCESS_TOKEN, DEVICE_CODE, FakeServer, REFRESH_TOKEN, USER_CODE, WHOAMI } from "./fake-server.js";
import { fakeClock, memoryKeyring, runCli, testStore, unreachableKeyring, type Extra } from "./helpers.js";

let server: FakeServer;
let dir: string;
let keyring: ReturnType<typeof memoryKeyring>;
let clock: ReturnType<typeof fakeClock>;

beforeEach(async () => {
  server = await new FakeServer().start();
  dir = mkdtempSync(join(tmpdir(), "cli-login-"));
  keyring = memoryKeyring();
  clock = fakeClock();
});

afterEach(async () => {
  await server.stop();
  rmSync(dir, { recursive: true, force: true });
});

interface Run {
  tty?: boolean;
  env?: NodeJS.ProcessEnv;
  io?: Extra;
}

/** Runs the command line against the stand-in, with this test's store and clock. */
function cli(args: string[], { tty = false, env = {}, io = {} }: Run = {}) {
  const fullEnv = { HAAU3_PLATFORM_URL: server.url, ...env };
  return runCli(args, {
    tty,
    env: fullEnv,
    io: { store: testStore(dir, keyring, fullEnv), now: clock.now, sleep: clock.sleep, ...io },
  });
}

const json = (text: string) => JSON.parse(text);
const stored = () => json(keyring.entries.get(server.url) ?? "null");

async function signIn() {
  await cli(["login"]);
  const out = await cli(["login", "--complete"]);
  expect(out.code).toBe(0);
  return out;
}

describe("login with no terminal, as an agent runs it", () => {
  it("prints the page, the code, when it expires and the next command, then exits", async () => {
    const out = await cli(["login"]);
    expect(out.code).toBe(0);
    const document = json(out.stdout);
    expect(document).toMatchObject({ formatVersion: "1.3", command: "login", ok: true, environment: null, error: null });
    expect(document.data).toEqual({
      status: "approval-needed",
      verificationUri: `${server.url}/device`,
      userCode: USER_CODE,
      expiresAt: new Date(clock.now() + 600_000).toISOString(),
      platform: server.url,
      signInService: server.issuer,
      next: [{ command: "npx haau3 login --complete", description: expect.stringContaining("run it again") }],
    });
    // Never the page with the code filled in (RFC 8628, section 5.4).
    expect(out.stdout).not.toContain("user_code=");
    expect(clock.slept).toEqual([]);
  });

  it("asks with the platform's client id and scope, and names itself", async () => {
    await cli(["login"]);
    const [device] = server.to("/issuer/device");
    expect(Object.fromEntries(new URLSearchParams(device!.body))).toEqual({ client_id: "client_fake", scope: "user:org:read" });
    expect(device!.headers["user-agent"]).toBe(`haau3-cli/${VERSION}`);
    expect(server.to("/.well-known/oauth-protected-resource/api/cli/v1")[0]!.headers["user-agent"]).toBe(`haau3-cli/${VERSION}`);
  });

  it("keeps the device code in the store, never in what it prints", async () => {
    const out = await cli(["login"]);
    expect(out.stdout).not.toContain(DEVICE_CODE);
    expect(stored().pending).toMatchObject({ deviceCode: DEVICE_CODE, userCode: USER_CODE, interval: 5 });
  });

  it("shows the same code again while it is still good, without asking for another", async () => {
    await cli(["login"]);
    clock.now = ((at) => () => at)(clock.now() + 8 * 60_000);
    const again = json((await cli(["login"])).stdout);
    expect(again.data.userCode).toBe(USER_CODE);
    expect(server.to("/issuer/device")).toHaveLength(1);
  });

  it("asks for a new code once the old one has under a minute left", async () => {
    await cli(["login"]);
    clock.now = ((at) => () => at)(clock.now() + 9.5 * 60_000);
    await cli(["login"]);
    expect(server.to("/issuer/device")).toHaveLength(2);
  });

  it("login --complete signs in once approved, keeps the session and drops the code", async () => {
    await cli(["login"]);
    const out = await cli(["login", "--complete"]);
    expect(out.code).toBe(0);
    const { data } = json(out.stdout);
    expect(data).toEqual({
      status: "signed-in",
      member: WHOAMI.member,
      organization: WHOAMI.organization,
      platform: server.url,
      session: { expiresAt: expect.any(String), store: "keyring", storeName: keyringName(), storePath: null },
      next: [{ command: "npx haau3 keys create", description: expect.any(String) }],
    });
    expect(stored().session).toMatchObject({ accessToken: ACCESS_TOKEN, member: WHOAMI.member, clientId: "client_fake" });
    expect(stored().pending).toBeUndefined();
    // It waited the interval before its first poll, since the run before may have polled moments ago.
    expect(clock.slept).toEqual([5_000]);
  });

  it("never keeps or sends the refresh token", async () => {
    await signIn();
    await cli(["whoami"]);
    await cli(["logout"]);
    expect([...keyring.entries.values()].join("")).not.toContain(REFRESH_TOKEN);
    expect(server.requests.map((r) => r.body + JSON.stringify(r.headers)).join("")).not.toContain(REFRESH_TOKEN);
  });

  it("ends the session at the platform's end, or an hour after approval if that comes first", async () => {
    const platformEnd = clock.now() + 30 * 60_000;
    server.whoamiExpiresAt = new Date(platformEnd).toISOString();
    const sooner = json((await signIn()).stdout);
    // Read on this computer's clock through the answer's Date header, which has whole seconds and the
    // real time, while the test's clock has moved on five seconds of polling.
    expect(Math.abs(Date.parse(sooner.data.session.expiresAt) - platformEnd)).toBeLessThan(7_000);

    // A platform answering later than an hour from approval is held to the hour.
    await cli(["logout"]);
    server.whoamiExpiresAt = new Date(clock.now() + 3 * 60 * 60_000).toISOString();
    await cli(["login"]);
    const approvedAt = clock.now() + 5_000;
    const later = json((await cli(["login", "--complete"])).stdout);
    expect(Date.parse(later.data.session.expiresAt)).toBe(approvedAt + 60 * 60_000);
  });

  it("says the approval is still pending after about 100 seconds, and keeps the code for the next run", async () => {
    server.tokenAnswers = ["pending"];
    await cli(["login"]);
    const out = await cli(["login", "--complete"]);
    expect(out.code).toBe(1);
    const { error } = json(out.stdout);
    expect(error.code).toBe("approval-pending");
    expect(error.message).toContain(`${server.url}/device`);
    expect(error.message).toContain(USER_CODE);
    expect(error.next[0].command).toBe("npx haau3 login --complete");
    // The waits, the last poll's own limit and what follows an approval all fit inside the run's limit.
    expect(clock.slept.reduce((a, b) => a + b, 0) + POLL_TIMEOUT_MS + 20_000).toBeLessThanOrEqual(COMPLETE_WAIT_MS);
    expect(clock.slept.length).toBeGreaterThanOrEqual(12);
    expect(stored().pending.deviceCode).toBe(DEVICE_CODE);
  });

  it("slows down by five seconds for each slow_down, and keeps the slower pace for the next run", async () => {
    server.tokenAnswers = ["slow_down", "slow_down", "pending"];
    await cli(["login"]);
    await cli(["login", "--complete"]);
    expect(clock.slept.slice(0, 4)).toEqual([5_000, 10_000, 15_000, 15_000]);
    expect(stored().pending.interval).toBe(15);
  });

  it("backs off when the sign-in service does not answer, then carries on", async () => {
    server.tokenAnswers = ["server-error", "server-error", "approved"];
    await cli(["login"]);
    const out = await cli(["login", "--complete"]);
    expect(out.code).toBe(0);
    expect(clock.slept).toEqual([5_000, 10_000, 20_000]);
  });

  it.each([
    ["expired", "code-expired"],
    ["denied", "approval-denied"],
    ["invalid_grant", "sign-in-failed"],
    ["not-bearer", "sign-in-failed"],
  ] as const)("ends on %s with %s, and forgets the code", async (answer, code) => {
    server.tokenAnswers = [answer];
    await cli(["login"]);
    const out = await cli(["login", "--complete"]);
    expect(out.code).toBe(1);
    expect(json(out.stdout).error.code).toBe(code);
    expect(keyring.entries.has(server.url)).toBe(false);
  });

  it("names the sign-in service's own error code when it refuses", async () => {
    server.tokenAnswers = ["invalid_grant"];
    await cli(["login"]);
    expect(json((await cli(["login", "--complete"])).stdout).error.message).toContain("(invalid_grant)");
  });

  it("says when nothing is waiting for approval", async () => {
    const out = await cli(["login", "--complete"]);
    expect(out.code).toBe(1);
    expect(json(out.stdout).error).toMatchObject({ code: "no-sign-in-pending", next: [{ command: "npx haau3 login" }] });
  });

  it("says the code expired when --complete comes too late", async () => {
    await cli(["login"]);
    clock.now = ((at) => () => at)(clock.now() + 11 * 60_000);
    const out = await cli(["login", "--complete"]);
    expect(json(out.stdout).error.code).toBe("code-expired");
    expect(keyring.entries.has(server.url)).toBe(false);
  });

  it("answers a --complete run after it worked with 'already signed in'", async () => {
    await signIn();
    const out = await cli(["login", "--complete"]);
    expect(out.code).toBe(0);
    expect(json(out.stdout).data.status).toBe("already-signed-in");
  });
});

describe("login when there is a session", () => {
  it("says so and stops while the session is good, and starts nothing", async () => {
    await signIn();
    const devices = server.to("/issuer/device").length;
    const out = await cli(["login"]);
    expect(out.code).toBe(0);
    const { data } = json(out.stdout);
    expect(data.status).toBe("already-signed-in");
    expect(data.member).toEqual(WHOAMI.member);
    expect(data.next.map((s: { command: string }) => s.command)).toEqual(["npx haau3 keys create", "npx haau3 whoami", "npx haau3 logout"]);
    expect(server.to("/issuer/device")).toHaveLength(devices);
  });

  it("revokes a session past its end and starts a new sign-in", async () => {
    await signIn();
    clock.now = ((at) => () => at)(clock.now() + 61 * 60_000);
    const out = await cli(["login"]);
    expect(json(out.stdout).data.status).toBe("approval-needed");
    expect(server.revoked).toEqual([ACCESS_TOKEN]);
    expect(stored().session).toBeUndefined();
  });
});

describe("login when the platform will not take the approval", () => {
  it.each([
    ["not-a-member", "not-a-member"],
    ["no-organization", "no-organization"],
    ["unauthorized", "sign-in-refused"],
    ["unavailable", "platform-unavailable"],
  ] as const)("whoami answering %s: %s, the token revoked, nothing kept", async (answer, code) => {
    server.whoamiAnswer = answer;
    await cli(["login"]);
    const out = await cli(["login", "--complete"]);
    expect(out.code).toBe(1);
    expect(json(out.stdout).error.code).toBe(code);
    expect(server.revoked).toEqual([ACCESS_TOKEN]);
    expect(keyring.entries.has(server.url)).toBe(false);
  });
});

describe("finding the sign-in service", () => {
  it("says signing in is not open yet when the platform has it off", async () => {
    server.platformMetadata = "off";
    const out = await cli(["login"]);
    expect(out.code).toBe(1);
    const { error } = json(out.stdout);
    expect(error.code).toBe("sign-in-unavailable");
    expect(error.message).toContain(`${server.url}/dashboard/keys`);
  });

  it("carries the platform's problem when it cannot answer", async () => {
    server.platformMetadata = "server-error";
    const { error } = json((await cli(["login"])).stdout);
    expect(error.code).toBe("platform-unavailable");
    expect(error.message).toContain("30 seconds");
    expect(error.problem).toEqual({ type: "about:blank", title: "Refused", status: 503, code: "unavailable", requestId: "req_fake_1" });
  });

  it("says the platform did not answer", async () => {
    await server.stop();
    const out = await cli(["login"]);
    expect(json(out.stdout).error.code).toBe("platform-unreachable");
  });

  it.each([
    ["platformMetadata", "other-resource"],
    ["platformMetadata", "no-client-id"],
    ["issuerMetadata", "other-issuer"],
    ["issuerMetadata", "foreign-endpoint"],
    ["issuerMetadata", "no-device-grant"],
    ["issuerMetadata", "missing"],
    ["deviceAnswer", "bad-code"],
  ] as const)("refuses metadata or a code that fails a check: %s %s", async (field, value) => {
    (server as unknown as Record<string, string>)[field] = value;
    const out = await cli(["login"]);
    expect(out.code).toBe(1);
    expect(json(out.stdout).error.code).toBe("unexpected-answer");
    expect(server.to("/issuer/token")).toHaveLength(0);
  });

  it("sends nothing to an endpoint off the issuer's own address", async () => {
    server.issuerMetadata = "foreign-endpoint";
    await cli(["login"]);
    expect(server.to("/issuer/device")).toHaveLength(0);
  });

  it("names the sign-in service's refusal to start", async () => {
    server.deviceAnswer = "invalid_client";
    const { error } = json((await cli(["login"])).stdout);
    expect(error.code).toBe("sign-in-failed");
    expect(error.message).toContain("(invalid_client)");
  });

  it("polls every five seconds when the sign-in service names no interval", async () => {
    server.interval = undefined;
    await cli(["login"]);
    await cli(["login", "--complete"]);
    expect(clock.slept).toEqual([5_000]);
  });

  it("refuses a HAAU3_PLATFORM_URL it cannot use, exit 2, without repeating it", async () => {
    const out = await cli(["login"], { env: { HAAU3_PLATFORM_URL: "http://platform.example.com/?secret=hunter2xyz" } });
    expect(out.code).toBe(2);
    expect(json(out.stdout).error.code).toBe("invalid-platform-url");
    expect(out.stdout).not.toContain("hunter2xyz");
  });
});

describe("login at a terminal, as a person runs it", () => {
  const person = (io: Extra = {}): Run => ({ tty: true, io: { stdin: { isTTY: true }, ...io } });

  it("shows the page and the code, waits, and says who is signed in and where it is kept", async () => {
    const out = await cli(["login"], person({ openBrowser: async () => true, enter: () => ({ pressed: new Promise(() => {}), stop() {} }) }));
    expect(out.code).toBe(0);
    expect(out.stdout).toContain("To sign in, open this page and enter the code.");
    expect(out.stdout).toContain(`  Page: ${server.url}/device\n  Code: ${USER_CODE}\n  The code expires at `);
    expect(out.stdout).toContain("Press Enter to open the page in your browser.\nWaiting for your approval...\n");
    expect(out.stdout).toContain("Signed in as dev@example.com in Example Org.\nThe session ends at ");
    expect(out.stdout).toContain(`It is kept in ${keyringName()}.`);
    expect(out.stdout).toContain("Next:\n  npx haau3 keys create\n");
    expect(out.stdout).not.toContain("user_code=");
    expect(out.stderr).toBe("");
  });

  it("opens the plain page, never the one with the code, when Enter is pressed", async () => {
    const opened: string[] = [];
    let stopped = false;
    await cli(["login"], person({ openBrowser: async (url) => (opened.push(url), true), enter: () => ({ pressed: Promise.resolve(), stop: () => (stopped = true) }) }));
    expect(opened).toEqual([`${server.url}/device`]);
    expect(stopped).toBe(true);
  });

  it("waits until the code expires, not just 100 seconds", async () => {
    server.tokenAnswers = ["pending"];
    const out = await cli(["login"], person());
    expect(out.code).toBe(1);
    expect(out.stderr).toContain("The code expired before it was approved.");
    expect(clock.slept.reduce((a, b) => a + b, 0)).toBeGreaterThan(COMPLETE_WAIT_MS);
  });

  it("offers no Enter where nothing can open a browser", async () => {
    const out = await cli(["login"], person());
    expect(out.stdout).not.toContain("Press Enter");
  });

  it("does not wait when an agent runs it in a pseudo-terminal", async () => {
    const out = await cli(["login"], { ...person(), env: { CURSOR_AGENT: "1" } });
    expect(json(out.stdout).data.status).toBe("approval-needed");
  });

  it("does not wait when stdin is not a terminal, and says the next command in text", async () => {
    const out = await cli(["login"], { tty: true });
    expect(out.code).toBe(0);
    expect(out.stdout).toContain(`Code: ${USER_CODE}`);
    expect(out.stdout).toContain("Next:\n  npx haau3 login --complete\n");
    expect(clock.slept).toEqual([]);
  });
});

describe("whoami", () => {
  it("says signed out, and how to sign in", async () => {
    const out = await cli(["whoami"]);
    expect(out.code).toBe(1);
    expect(json(out.stdout).error).toMatchObject({ code: "not-signed-in", next: [{ command: "npx haau3 login" }] });
  });

  it("points at login --complete while a sign-in waits for approval", async () => {
    await cli(["login"]);
    expect(json((await cli(["whoami"])).stdout).error.next[0].command).toBe("npx haau3 login --complete");
  });

  it("says who, where, on which plan, this month's use and when the session ends", async () => {
    await signIn();
    const out = await cli(["whoami"]);
    expect(out.code).toBe(0);
    const document = json(out.stdout);
    expect(document).toMatchObject({ command: "whoami", ok: true, environment: null });
    expect(document.data).toEqual({
      member: WHOAMI.member,
      organization: WHOAMI.organization,
      role: "org:admin",
      plan: WHOAMI.plan,
      usage: WHOAMI.usage,
      session: { expiresAt: expect.any(String), store: "keyring", storeName: keyringName(), storePath: null },
      // Switching organization is signing in again, and picking it on the approval page.
      next: [{ command: "npx haau3 logout", description: "Sign out, then sign in again to pick another organization." }],
    });
    const [whoamiCall] = server.to("/api/cli/v1/whoami").slice(-1);
    expect(whoamiCall!.headers.authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
  });

  it("reads as five lines at a terminal, the last how to act for another organization", async () => {
    await signIn();
    const out = await cli(["whoami"], { tty: true });
    const lines = out.stdout.split("\n");
    expect(lines[0]).toBe("dev@example.com, admin in Example Org (example-org)");
    expect(lines[1]).toBe("Plan: Developer. 312 of 1,000 requests this month.");
    expect(lines[2]).toMatch(/^The session ends at .+, in 60 minutes\.$/);
    expect(lines[3]).toBe(`It is kept in ${keyringName()}.`);
    expect(lines[4]).toBe("To act for another organization, sign out, then sign in and pick it on the approval page.");
    expect(out.stdout).toContain("npx haau3 logout");
  });

  it("ends a session past its end without asking the platform", async () => {
    await signIn();
    const calls = server.to("/api/cli/v1/whoami").length;
    clock.now = ((at) => () => at)(clock.now() + 61 * 60_000);
    const out = await cli(["whoami"]);
    expect(json(out.stdout).error.code).toBe("session-ended");
    expect(server.to("/api/cli/v1/whoami")).toHaveLength(calls);
    expect(server.revoked).toEqual([ACCESS_TOKEN]);
    expect(keyring.entries.has(server.url)).toBe(false);
  });

  it.each([
    ["unauthorized", "session-ended"],
    ["not-a-member", "not-a-member"],
    ["no-organization", "no-organization"],
  ] as const)("a platform answering %s: %s, the session revoked and deleted", async (answer, code) => {
    await signIn();
    server.whoamiAnswer = answer;
    const out = await cli(["whoami"]);
    expect(out.code).toBe(1);
    const { error } = json(out.stdout);
    expect(error.code).toBe(code);
    expect(error.next[0].command).toBe("npx haau3 login");
    expect(server.revoked).toEqual([ACCESS_TOKEN]);
    expect(keyring.entries.has(server.url)).toBe(false);
  });

  it("names the organization a removed member left", async () => {
    await signIn();
    server.whoamiAnswer = "not-a-member";
    expect(json((await cli(["whoami"])).stdout).error.message).toContain("You are not a member of Example Org.");
  });

  it.each([
    ["unavailable", "platform-unavailable"],
    ["garbled", "unexpected-answer"],
  ] as const)("a platform answering %s: %s, the session kept", async (answer, code) => {
    await signIn();
    server.whoamiAnswer = answer;
    const out = await cli(["whoami"]);
    expect(json(out.stdout).error.code).toBe(code);
    expect(server.revoked).toEqual([]);
    expect(stored().session).toBeDefined();
  });
});

describe("logout", () => {
  it("revokes the token, deletes the session and says so", async () => {
    await signIn();
    const out = await cli(["logout"]);
    expect(out.code).toBe(0);
    expect(json(out.stdout).data).toEqual({ status: "signed-out", revoked: true, pendingCleared: false, copyLeft: false });
    expect(keyring.entries.has(server.url)).toBe(false);
    const [revocation] = server.to("/issuer/revoke");
    expect(Object.fromEntries(new URLSearchParams(revocation!.body))).toEqual({ token: ACCESS_TOKEN, token_type_hint: "access_token", client_id: "client_fake" });
    expect((await cli(["logout"], { tty: true })).stdout).toBe("Already signed out.\n");
  });

  it("reads as one line at a terminal", async () => {
    await signIn();
    expect((await cli(["logout"], { tty: true })).stdout).toBe("Signed out. The approval has ended too.\n");
  });

  it("exits 1 when the approval could not be ended, having deleted the session all the same", async () => {
    await signIn();
    server.revokeStatus = 503;
    const out = await cli(["logout"]);
    expect(out.code).toBe(1);
    const { error } = json(out.stdout);
    expect(error.code).toBe("revoke-failed");
    expect(error.message).toMatch(/^Signed out on this computer, but the sign-in service could not be reached to end the approval\. 127\.0\.0\.1:\d+ stops taking it at /);
    expect(keyring.entries.has(server.url)).toBe(false);
  });

  it("says the platform already stopped taking a session past its end", async () => {
    await signIn();
    server.revokeStatus = 503;
    clock.now = ((at) => () => at)(clock.now() + 61 * 60_000);
    expect(json((await cli(["logout"])).stdout).error.message).toContain("already stopped taking it");
  });

  it("is fine with nothing to sign out of", async () => {
    const out = await cli(["logout"]);
    expect(out.code).toBe(0);
    expect(json(out.stdout).data).toEqual({ status: "already-signed-out", revoked: false, pendingCleared: false, copyLeft: false });
    expect(server.requests).toEqual([]);
  });

  it("cancels a sign-in waiting for approval", async () => {
    await cli(["login"]);
    const out = await cli(["logout"], { tty: true });
    expect(out.stdout).toBe("Already signed out. The sign-in that was waiting for approval is cancelled.\n");
    expect(keyring.entries.has(server.url)).toBe(false);
  });
});

describe("where the session is kept", () => {
  it("falls back to a file only the user can read when the credential store cannot be reached, and says so", async () => {
    const blocked = unreachableKeyring();
    const io = { store: testStore(dir, blocked, { HAAU3_PLATFORM_URL: server.url }) };
    await cli(["login"], { io });
    const out = await cli(["login", "--complete"], { tty: false, io });
    const { data } = json(out.stdout);
    expect(data.session).toMatchObject({ store: "file", storeName: "a file only you can read", storePath: join(dir, "session.json") });
    if (process.platform !== "win32") expect(statSync(join(dir, "session.json")).mode & 0o777).toBe(0o600);
    const text = await cli(["whoami"], { tty: true, io });
    expect(text.stdout).toContain(`It is kept in a file only you can read, since the system's credential store could not be reached:\n  ${join(dir, "session.json")}`);
  });

  it("goes straight to the file when HAAU3_SESSION_STORE=file asks, never touching the credential store", async () => {
    const blocked = unreachableKeyring();
    const env = { HAAU3_SESSION_STORE: "file" };
    const io = { store: testStore(dir, blocked, { HAAU3_PLATFORM_URL: server.url, ...env }) };
    await cli(["login"], { env, io });
    await cli(["login", "--complete"], { env, io });
    const text = await cli(["whoami"], { tty: true, env, io });
    expect(text.stdout).toContain("as HAAU3_SESSION_STORE asks");
    await cli(["logout"], { env, io });
    expect(blocked.calls).toBe(0);
  });

  it("keeps a session per platform address", async () => {
    await signIn();
    const elsewhere = await cli(["whoami"], { env: { HAAU3_PLATFORM_URL: server.url.replace("127.0.0.1", "localhost") } });
    expect(json(elsewhere.stdout).error.code).toBe("not-signed-in");
  });
});

describe("the commands' arguments", () => {
  it("refuses --complete anywhere but login", async () => {
    const out = await cli(["whoami", "--complete"]);
    expect(out.code).toBe(2);
    expect(json(out.stdout).error).toMatchObject({ code: "unknown-flag", message: "haau3 has no flag --complete." });
  });

  it("refuses an extra argument without repeating it", async () => {
    const out = await cli(["logout", "everything-please"]);
    expect(out.code).toBe(2);
    const document = json(out.stdout);
    expect(document.command).toBe("logout");
    expect(document.error).toMatchObject({ code: "unexpected-argument", message: "haau3 logout takes no arguments." });
    expect(out.stdout).not.toContain("everything-please");
  });
});
