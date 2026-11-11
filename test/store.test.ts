// The session store: where the file goes on each system, what the file and the record hold, the
// choice between the credential store and the file, and, with HAAU3_TEST_OS_STORE=1 (CI sets it on
// every system), the operating system's own credential store for real.
import { randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configDir, FileStore } from "../src/session/file.js";
import { keyringName, osKeyring } from "../src/session/keyring.js";
import { fromStored, toStored, type SessionRecord } from "../src/session/record.js";
import { sessionStore } from "../src/session/store.js";
import { AccessToken, DeviceCode } from "../src/signin/secret.js";
import { memoryKeyring, unreachableKeyring } from "./helpers.js";

const ADDRESS = "https://platform.example.com";
const SERVICE = { platformURL: ADDRESS, issuer: "https://auth.example.com", clientId: "client_1", scope: "user:org:read", deviceEndpoint: "https://auth.example.com/device", tokenEndpoint: "https://auth.example.com/token", revocationEndpoint: "https://auth.example.com/revoke" };

function record(): SessionRecord {
  return {
    session: {
      accessToken: new AccessToken("oat_made_up_token"),
      expiresAt: Date.parse("2026-11-11T19:00:00.000Z"),
      issuer: SERVICE.issuer,
      clientId: SERVICE.clientId,
      revocationEndpoint: SERVICE.revocationEndpoint,
      member: { id: "user_1", email: null },
      organization: { id: "org_1", name: "Example Org", slug: null },
    },
    pending: {
      deviceCode: new DeviceCode("made_up_device_code"),
      userCode: "WDJB-MJHT",
      verificationUri: "https://auth.example.com/device",
      expiresAt: Date.parse("2026-11-11T18:10:00.000Z"),
      interval: 10,
      service: SERVICE,
    },
  };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cli-store-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("where the file goes", () => {
  const home = join("/", "home", "someone");

  it("follows HAAU3_CONFIG_DIR first, on every system", () => {
    for (const platform of ["darwin", "linux", "win32"] as const) {
      expect(configDir({ HAAU3_CONFIG_DIR: "/somewhere", XDG_CONFIG_HOME: "/xdg", APPDATA: "C:\\AppData" }, platform, home)).toBe("/somewhere");
    }
  });

  it("then an absolute XDG_CONFIG_HOME, as GitHub's command line does", () => {
    expect(configDir({ XDG_CONFIG_HOME: "/xdg" }, "linux", home)).toBe(join("/xdg", "haau3"));
    expect(configDir({ XDG_CONFIG_HOME: "/xdg", APPDATA: "C:\\AppData" }, "win32", home)).toBe(join("/xdg", "haau3"));
    expect(configDir({ XDG_CONFIG_HOME: "relative/xdg" }, "linux", home)).toBe(join(home, ".config", "haau3"));
  });

  it("then APPDATA on Windows, else ~/.config/haau3", () => {
    expect(configDir({ APPDATA: "C:\\AppData" }, "win32", home)).toBe(join("C:\\AppData", "haau3"));
    expect(configDir({ APPDATA: "C:\\AppData" }, "darwin", home)).toBe(join(home, ".config", "haau3"));
    expect(configDir({}, "win32", home)).toBe(join(home, ".config", "haau3"));
    expect(configDir({}, "darwin", home)).toBe(join(home, ".config", "haau3"));
  });
});

describe("the file", () => {
  it("keeps a record per address, and deletes itself when the last goes", () => {
    const file = new FileStore(join(dir, "haau3"));
    const stored = toStored(record());
    file.write(ADDRESS, stored);
    file.write("http://localhost:3002", { pending: stored.pending! });
    expect(file.read(ADDRESS)).toEqual(stored);
    expect(file.read("http://localhost:3002")).toEqual({ pending: stored.pending });
    file.remove(ADDRESS);
    expect(file.read(ADDRESS)).toBeNull();
    file.remove("http://localhost:3002");
    expect(() => statSync(file.path)).toThrow();
  });

  it.skipIf(process.platform === "win32")("is 0600 in a 0700 folder", () => {
    const file = new FileStore(join(dir, "haau3"));
    file.write(ADDRESS, toStored(record()));
    expect(statSync(file.path).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "haau3")).mode & 0o777).toBe(0o700);
  });

  it("is written through a new file renamed into place, leaving nothing else behind", () => {
    const file = new FileStore(dir);
    for (let i = 0; i < 5; i++) file.write(`${ADDRESS}/${i}`, toStored(record()));
    expect(readdirSync(dir)).toEqual(["session.json"]);
  });

  it("starts again over a file that is not its own, or too big to be one", () => {
    const file = new FileStore(dir);
    writeFileSync(file.path, "not json");
    expect(file.read(ADDRESS)).toBeNull();
    file.write(ADDRESS, toStored(record()));
    expect(JSON.parse(readFileSync(file.path, "utf8")).version).toBe(1);
    writeFileSync(file.path, JSON.stringify({ version: 1, records: { [ADDRESS]: {} }, padding: "x".repeat(1024 * 1024) }));
    expect(file.read(ADDRESS)).toBeNull();
  });
});

describe("the record", () => {
  it("survives being kept, the secrets held hidden again when read back", () => {
    const back = fromStored(JSON.parse(JSON.stringify(toStored(record()))), ADDRESS);
    expect(back.session!.accessToken.reveal()).toBe("oat_made_up_token");
    expect(back.pending!.deviceCode.reveal()).toBe("made_up_device_code");
    expect(back.pending!.service).toEqual(SERVICE);
    expect(back.pending!.interval).toBe(10);
    expect(String(back.session!.accessToken)).toBe("[haau3 token hidden]");
    expect(inspect(back)).not.toContain("made_up");
    expect(JSON.stringify(back)).not.toContain("made_up");
  });

  it("keeps the platform's address as the key, not in the record", () => {
    expect(JSON.stringify(toStored(record()))).not.toContain(ADDRESS);
  });

  it("drops a part that is not whole, and keeps the other", () => {
    const stored = toStored(record()) as any;
    delete stored.session.accessToken;
    const back = fromStored(stored, ADDRESS);
    expect(back.session).toBeUndefined();
    expect(back.pending).toBeDefined();
    stored.pending.interval = 0;
    expect(fromStored(stored, ADDRESS)).toEqual({});
    expect(fromStored("garbage", ADDRESS)).toEqual({});
  });
});

describe("the store", () => {
  it("uses the credential store first, and says so", async () => {
    const keyring = memoryKeyring();
    const store = sessionStore({ env: { HAAU3_CONFIG_DIR: dir }, keyring });
    const where = await store.save(ADDRESS, record());
    expect(where).toEqual({ kind: "keyring", name: keyringName(), path: null, reason: null });
    expect(keyring.entries.has(ADDRESS)).toBe(true);
    expect(() => statSync(store.filePath)).toThrow();
    const loaded = await store.load(ADDRESS);
    expect(loaded.where?.kind).toBe("keyring");
    expect(loaded.record.session?.organization.name).toBe("Example Org");
  });

  it("falls back to the file when the credential store cannot be reached, for reading and writing", async () => {
    const store = sessionStore({ env: { HAAU3_CONFIG_DIR: dir }, keyring: unreachableKeyring() });
    const where = await store.save(ADDRESS, record());
    expect(where).toEqual({ kind: "file", name: "a file only you can read", path: join(dir, "session.json"), reason: "unreachable" });
    expect((await store.load(ADDRESS)).where?.reason).toBe("unreachable");
  });

  it("moves a copy the file kept back into the credential store once it can be reached", async () => {
    await sessionStore({ env: { HAAU3_CONFIG_DIR: dir }, keyring: unreachableKeyring() }).save(ADDRESS, record());
    const keyring = memoryKeyring();
    const store = sessionStore({ env: { HAAU3_CONFIG_DIR: dir }, keyring });
    const loaded = await store.load(ADDRESS);
    expect(loaded.where).toMatchObject({ kind: "file", reason: null });
    await store.save(ADDRESS, loaded.record);
    expect(keyring.entries.has(ADDRESS)).toBe(true);
    expect(() => statSync(store.filePath)).toThrow();
  });

  it("clears both stores, and an empty record is a clear", async () => {
    const keyring = memoryKeyring();
    await sessionStore({ env: { HAAU3_CONFIG_DIR: dir }, keyring: unreachableKeyring() }).save(ADDRESS, record());
    const store = sessionStore({ env: { HAAU3_CONFIG_DIR: dir }, keyring });
    await keyring.write(ADDRESS, toStored(record()));
    expect(await store.save(ADDRESS, {})).toBeNull();
    expect(keyring.entries.size).toBe(0);
    expect(() => statSync(store.filePath)).toThrow();
  });

  it("asks the credential store to delete only what it holds", async () => {
    let removes = 0;
    const keyring = { ...memoryKeyring(), remove: async () => void removes++ };
    await sessionStore({ env: { HAAU3_CONFIG_DIR: dir }, keyring }).clear(ADDRESS);
    expect(removes).toBe(0);
  });

  it("with HAAU3_SESSION_STORE=file, never touches the credential store", async () => {
    const keyring = unreachableKeyring();
    const store = sessionStore({ env: { HAAU3_CONFIG_DIR: dir, HAAU3_SESSION_STORE: "file" }, keyring });
    expect((await store.save(ADDRESS, record()))?.reason).toBe("asked");
    expect((await store.load(ADDRESS)).where?.reason).toBe("asked");
    await store.clear(ADDRESS);
    expect(keyring.calls).toBe(0);
  });

  it("says when neither store would keep it", async () => {
    writeFileSync(join(dir, "not-a-folder"), "");
    const store = sessionStore({ env: { HAAU3_CONFIG_DIR: join(dir, "not-a-folder") }, keyring: unreachableKeyring() });
    expect(await store.save(ADDRESS, record())).toBeNull();
  });
});

describe("a file or folder someone else could have written", () => {
  const posix = process.platform !== "win32";

  it("is ignored when HAAU3_CONFIG_DIR is relative, as a relative XDG_CONFIG_HOME is", () => {
    expect(configDir({ HAAU3_CONFIG_DIR: ".haau3" }, "linux", join("/", "home", "someone"))).toBe(join("/", "home", "someone", ".config", "haau3"));
  });

  it.runIf(posix)("is not read when others can read or write it, or when it is a symlink", () => {
    const file = new FileStore(dir);
    file.write(ADDRESS, toStored(record()));
    expect(file.read(ADDRESS)).not.toBeNull();
    chmodSync(file.path, 0o644);
    expect(file.read(ADDRESS)).toBeNull();
    chmodSync(file.path, 0o600);
    const elsewhere = join(dir, "elsewhere.json");
    renameSync(file.path, elsewhere);
    symlinkSync(elsewhere, file.path);
    expect(file.read(ADDRESS)).toBeNull();
  });

  it.runIf(posix)("is neither read nor written in a folder others can write", () => {
    const file = new FileStore(dir);
    file.write(ADDRESS, toStored(record()));
    chmodSync(dir, 0o777);
    try {
      expect(file.read(ADDRESS)).toBeNull();
      expect(() => file.write(ADDRESS, toStored(record()))).toThrow();
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  it("is read back with the checks it passed when it was made", () => {
    const planted = toStored(record()) as any;
    planted.pending.verificationUri = "http://evil.example/activate";
    expect(fromStored(planted, ADDRESS).pending).toBeUndefined();
    const filledIn = toStored(record()) as any;
    filledIn.pending.verificationUri = "https://auth.example.com/device?user_code=WDJB-MJHT";
    expect(fromStored(filledIn, ADDRESS).pending).toBeUndefined();
    const offOrigin = toStored(record()) as any;
    offOrigin.pending.service.tokenEndpoint = "https://evil.example/token";
    expect(fromStored(offOrigin, ADDRESS).pending).toBeUndefined();
    const notACode = toStored(record()) as any;
    notACode.pending.userCode = "click here";
    expect(fromStored(notACode, ADDRESS).pending).toBeUndefined();
    const plainHttp = toStored(record()) as any;
    plainHttp.session.issuer = "http://auth.example.com";
    expect(fromStored(plainHttp, ADDRESS).session).toBeUndefined();
  });

  it("sweeps a temporary file a killed run left, which holds a session too", () => {
    const file = new FileStore(dir);
    const stale = join(dir, ".session.json.abc123.tmp");
    writeFileSync(stale, "{}", { mode: 0o600 });
    utimesSync(stale, new Date(Date.now() - 120_000), new Date(Date.now() - 120_000));
    file.write(ADDRESS, toStored(record()));
    expect(readdirSync(dir)).toEqual(["session.json"]);
  });
});

describe("the credential store's bound", () => {
  it("kills a call that outlives it, and treats the store as out of reach for the rest of the run", async () => {
    // Killed a millisecond in, before it can reach any store.
    const keyring = osKeyring(`haau3-cli-test-${randomBytes(4).toString("hex")}`, 1);
    const started = Date.now();
    await expect(keyring.read(ADDRESS)).rejects.toThrow("did not answer in time");
    await expect(keyring.read(ADDRESS)).rejects.toThrow("earlier in this run");
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("sends a record too big for every store to the file instead", async () => {
    const keyring = osKeyring(`haau3-cli-test-${randomBytes(4).toString("hex")}`, 1);
    const big = toStored(record()) as any;
    big.session.organization.name = "x".repeat(3000);
    await expect(keyring.write(ADDRESS, big)).rejects.toThrow("Too big");
  });
});

// The real thing, under a service name of the test's own so a person's session is never touched.
describe.runIf(process.env.HAAU3_TEST_OS_STORE === "1")("the operating system's credential store", () => {
  const service = `haau3-cli-test-${randomBytes(4).toString("hex")}`;
  const keyring = osKeyring(service);

  it("keeps, reads back and deletes a record", async () => {
    const stored = toStored(record());
    await keyring.write(ADDRESS, stored);
    try {
      expect(await keyring.read(ADDRESS)).toEqual(stored);
    } finally {
      await keyring.remove(ADDRESS);
    }
    expect(await keyring.read(ADDRESS)).toBeNull();
  });

  it("is the store the session goes to, by name", async () => {
    const store = sessionStore({ env: { HAAU3_CONFIG_DIR: dir }, keyring });
    try {
      expect((await store.save(ADDRESS, record()))?.kind).toBe("keyring");
      expect((await store.load(ADDRESS)).record.session?.accessToken.reveal()).toBe("oat_made_up_token");
    } finally {
      await store.clear(ADDRESS);
    }
    expect((await store.load(ADDRESS)).where).toBeNull();
    expect(() => statSync(store.filePath)).toThrow();
  });
});
