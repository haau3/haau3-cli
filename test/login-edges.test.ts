// The edges of signing in: two runs on one code, a server that rate-limits or answers oddly, a code
// near its end, a clock that is off, a stored code nobody here asked for, a credential store that
// cannot be reached, and two stores that disagree.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadRecord } from "../src/commands/session.js";
import { DEFAULT_PLATFORM_URL } from "../src/environment.js";
import { toStored, type SessionRecord } from "../src/session/record.js";
import { sessionStore } from "../src/session/store.js";
import { issuerAllowed } from "../src/signin/discovery.js";
import { AccessToken } from "../src/signin/secret.js";
import { ACCESS_TOKEN, FakeServer, USER_CODE } from "./fake-server.js";
import { fakeClock, memoryKeyring, runCli, testStore, unreachableKeyring, type Extra } from "./helpers.js";

let server: FakeServer;
let dir: string;
let keyring: ReturnType<typeof memoryKeyring>;
let clock: ReturnType<typeof fakeClock>;

beforeEach(async () => {
  server = await new FakeServer().start();
  dir = mkdtempSync(join(tmpdir(), "cli-edges-"));
  keyring = memoryKeyring();
  clock = fakeClock();
});

afterEach(async () => {
  await server.stop();
  rmSync(dir, { recursive: true, force: true });
});

function cli(args: string[], { tty = false, env = {}, io = {} }: { tty?: boolean; env?: NodeJS.ProcessEnv; io?: Extra } = {}) {
  const fullEnv = { HAAU3_PLATFORM_URL: server.url, ...env };
  return runCli(args, { tty, env: fullEnv, io: { store: testStore(dir, keyring, fullEnv), now: clock.now, sleep: clock.sleep, ...io } });
}

const json = (text: string) => JSON.parse(text);
const stored = () => json(keyring.entries.get(server.url) ?? "null");
const person = (io: Extra = {}) => ({ tty: true, io: { stdin: { isTTY: true }, ...io } });

describe("two runs waiting on one code", () => {
  it("leave the winner's session alone, and the other points at whoami", async () => {
    await cli(["login"]);
    const [a, b] = await Promise.all([cli(["login", "--complete"]), cli(["login", "--complete"])]);
    const documents = [a, b].map((out) => json(out.stdout));
    const winner = documents.find((d) => d.ok)!;
    const loser = documents.find((d) => d !== winner)!;
    expect(winner.data.status).toBe("signed-in");
    // The loser cannot see the winner's session until it is kept, so it says so and names whoami.
    expect(loser.data?.status === "already-signed-in" || loser.error.next[0].command === "npx haau3 whoami").toBe(true);
    expect(stored().session.accessToken).toBe(ACCESS_TOKEN);
    expect(stored().pending).toBeUndefined();
    expect(server.revoked).toEqual([]);
    expect(json((await cli(["whoami"])).stdout).ok).toBe(true);
  });

  it("answer 'already signed in' when the winner's session is kept by the time the other gives up", async () => {
    await cli(["login"]);
    const pending = stored().pending;
    await cli(["login", "--complete"]);
    // The other run read the code before the winner kept its session, and polls the spent code now.
    keyring.entries.set(server.url, JSON.stringify({ ...stored(), pending }));
    const late = await cli(["login", "--complete"]);
    expect(json(late.stdout).data.status).toBe("already-signed-in");
    expect(stored().session.accessToken).toBe(ACCESS_TOKEN);
    expect(stored().pending).toBeUndefined();
    expect(server.revoked).toEqual([]);
  });
});

describe("a token endpoint that answers oddly", () => {
  it("waits out a 429 as long as Retry-After asks, keeping the code", async () => {
    server.tokenAnswers = ["rate-limited", "approved"];
    await cli(["login"]);
    const out = await cli(["login", "--complete"]);
    expect(json(out.stdout).data.status).toBe("signed-in");
    expect(clock.slept).toEqual([5_000, 30_000]);
  });

  it("reads an OAuth error whatever status it came with", async () => {
    server.tokenAnswers = ["pending-as-200", "approved"];
    await cli(["login"]);
    expect(json((await cli(["login", "--complete"])).stdout).data.status).toBe("signed-in");
    expect(clock.slept).toEqual([5_000, 5_000]);
  });

  it("revokes a token it will not use", async () => {
    server.tokenAnswers = ["not-bearer"];
    await cli(["login"]);
    expect(json((await cli(["login", "--complete"])).stdout).error.code).toBe("sign-in-failed");
    expect(server.revoked).toEqual([ACCESS_TOKEN]);
  });

  it("never asks for offline_access, even when the platform lists it", async () => {
    server.scopes = ["user:org:read", "offline_access"];
    await cli(["login"]);
    expect(new URLSearchParams(server.to("/issuer/device")[0]!.body).get("scope")).toBe("user:org:read");
  });
});

describe("the pace of polling", () => {
  it("never polls faster than an interval above a minute", async () => {
    server.interval = 70;
    server.tokenAnswers = ["pending", "approved"];
    await cli(["login"], person());
    expect(clock.slept).toEqual([70_000, 70_000]);
  });

  it("cuts a backoff short so the last poll lands before the code expires, never the interval", async () => {
    server.expiresIn = 60;
    server.tokenAnswers = ["server-error", "server-error", "server-error", "approved"];
    const out = await cli(["login"], person());
    expect(out.code).toBe(0);
    expect(clock.slept).toEqual([5_000, 10_000, 20_000, 24_000]);
  });
});

describe("a clock that is off", () => {
  it("still gives an hour when this computer's clock is two hours ahead", async () => {
    clock = fakeClock(Date.now() + 2 * 60 * 60_000);
    await cli(["login"]);
    const signedIn = json((await cli(["login", "--complete"])).stdout);
    expect(Date.parse(signedIn.data.session.expiresAt) - clock.now()).toBeGreaterThan(55 * 60_000);
    const who = await cli(["whoami"]);
    expect(who.code).toBe(0);
  });
});

describe("a stored code", () => {
  it("is shown again only when it was made with the sign-in service the platform names now", async () => {
    await cli(["login"]);
    const record = stored();
    record.pending.service.clientId = "someone_else";
    keyring.entries.set(server.url, JSON.stringify(record));
    await cli(["login"]);
    expect(server.to("/issuer/device")).toHaveLength(2);
    expect(stored().pending.service.clientId).toBe("client_fake");
  });
});

describe("where it signs in", () => {
  it("says so when it is not haau3's own platform, naming both hosts", async () => {
    const out = await cli(["login"], { tty: true });
    const host = new URL(server.url).host;
    expect(out.stdout.split("\n")[0]).toBe(`Signing in to ${host} through ${host}, as HAAU3_PLATFORM_URL asks.`);
  });

  it("refuses a sign-in service off haau3.com for haau3's own platform, and allows any for another", () => {
    expect(issuerAllowed(DEFAULT_PLATFORM_URL, "https://auth.platform.haau3.com")).toBe(true);
    expect(issuerAllowed(DEFAULT_PLATFORM_URL, "https://haau3.com")).toBe(true);
    expect(issuerAllowed(DEFAULT_PLATFORM_URL, "https://auth.example.com")).toBe(false);
    expect(issuerAllowed(DEFAULT_PLATFORM_URL, "https://haau3.com.example.com")).toBe(false);
    expect(issuerAllowed(DEFAULT_PLATFORM_URL, "https://evilhaau3.com")).toBe(false);
    expect(issuerAllowed("http://localhost:3002", "https://auth.example.com")).toBe(true);
  });

  it("shows a name someone chose with anything that could steer a terminal replaced", async () => {
    server.organizationName = "Acme\u009b2J‮Labs";
    await cli(["login"]);
    await cli(["login", "--complete"]);
    const out = await cli(["whoami"], { tty: true });
    expect(out.stdout).toContain("Acme�2J�Labs");
    expect(out.stdout).not.toMatch(/[\u009b‮]/);
  });
});

describe("a credential store that cannot be reached", () => {
  it("makes logout say it could not check there, after ending what it could", async () => {
    const blocked = unreachableKeyring();
    const io = { store: testStore(dir, blocked, { HAAU3_PLATFORM_URL: server.url }) };
    await cli(["login"], { io });
    await cli(["login", "--complete"], { io });
    const out = await cli(["logout"], { io });
    expect(out.code).toBe(1);
    const { error } = json(out.stdout);
    expect(error.code).toBe("store-unreachable");
    expect(error.message).toContain("The session in the file is ended and deleted.");
    expect(server.revoked).toEqual([ACCESS_TOKEN]);

    const again = await cli(["logout"], { io });
    expect(again.code).toBe(1);
    expect(json(again.stdout).error.message).toContain("No session was found in the file.");
  });

  it("makes whoami say a session kept there could not be checked", async () => {
    const io = { store: testStore(dir, unreachableKeyring(), { HAAU3_PLATFORM_URL: server.url }) };
    expect(json((await cli(["whoami"], { io })).stdout).error.message).toContain("could not be checked");
  });

  it("is not looked at with HAAU3_SESSION_STORE=file, and logout says so", async () => {
    const env = { HAAU3_SESSION_STORE: "file" };
    const io = { store: testStore(dir, unreachableKeyring(), { HAAU3_PLATFORM_URL: server.url, ...env }) };
    const out = await cli(["logout"], { tty: true, env, io });
    expect(out.code).toBe(0);
    expect(out.stdout).toBe("Already signed out. Only the file was checked, as HAAU3_SESSION_STORE asks.\n");
  });
});

describe("two stores that disagree", () => {
  const session = (token: string, endsInMinutes: number): SessionRecord => ({
    session: {
      accessToken: new AccessToken(token),
      expiresAt: Date.now() + endsInMinutes * 60_000,
      issuer: server.issuer,
      clientId: "client_fake",
      revocationEndpoint: `${server.issuer}/revoke`,
      member: { id: "user_1", email: null },
      organization: { id: "org_1", name: "Example Org", slug: null },
    },
  });

  it("become one: the session that ends last is kept, the other's grant ended before it goes", async () => {
    // A run in a sandbox kept a newer session in the file while the credential store held an older one.
    await sessionStore({ env: { HAAU3_CONFIG_DIR: dir }, keyring: unreachableKeyring() }).save(server.url, session("tok_newer", 50));
    await keyring.write(server.url, toStored(session("tok_older", 5)));
    const store = testStore(dir, keyring);
    const current = await loadRecord({ store } as never, server.url);
    expect(current.record.session?.accessToken.reveal()).toBe("tok_newer");
    expect(server.revoked).toEqual(["tok_older"]);
    expect(stored().session.accessToken).toBe("tok_newer");
    expect((await store.load(server.url)).other).toBeNull();
  });

  it("leave alone a session both hold, revoking nothing", async () => {
    await sessionStore({ env: { HAAU3_CONFIG_DIR: dir }, keyring: unreachableKeyring() }).save(server.url, session("tok_same", 50));
    await keyring.write(server.url, toStored(session("tok_same", 50)));
    await loadRecord({ store: testStore(dir, keyring) } as never, server.url);
    expect(server.revoked).toEqual([]);
  });
});

describe("login --complete with nothing waiting", () => {
  it("ends a session past its end that it finds", async () => {
    await cli(["login"]);
    await cli(["login", "--complete"]);
    clock.now = ((at) => () => at)(clock.now() + 61 * 60_000);
    const out = await cli(["login", "--complete"]);
    expect(json(out.stdout).error.code).toBe("no-sign-in-pending");
    expect(server.revoked).toEqual([ACCESS_TOKEN]);
    expect(keyring.entries.has(server.url)).toBe(false);
  });

  it("names the code it is still waiting on", async () => {
    server.tokenAnswers = ["pending"];
    await cli(["login"]);
    expect(json((await cli(["login", "--complete"])).stdout).error.message).toContain(USER_CODE);
  });
});
