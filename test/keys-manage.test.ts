// haau3 keys list and keys revoke against a stand-in platform, in real folders: what each lists and
// marks, every refusal and when it spends nothing, the question a person at a terminal answers before
// a key is revoked, the refusal anyone else gets, every answer the platform can give, and when the
// session ends. Revoking ends the sign-in, as making a key does; listing and reading keep it.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HIDDEN_NAME } from "../src/signin/keys.js";
import { confirmOnTerminal, sameText } from "../src/terminal.js";
import {
  FakeServer,
  LISTED_KEY_ID,
  LISTED_NAME,
  LISTED_PREFIX,
  listedKey,
  MANAGED_KEY_ID,
  REVOKED_KEY_ID,
  UNKNOWN_KEY_ID,
  type KeyReadAnswer,
  type RevokeKeyAnswer,
} from "./fake-server.js";
import { cleanEnv, fakeClock, memoryKeyring, runCli, testStore } from "./helpers.js";

let server: FakeServer;
let dir: string;
let project: string;
let keyring: ReturnType<typeof memoryKeyring>;
let clock: ReturnType<typeof fakeClock>;

beforeEach(async () => {
  server = await new FakeServer().start();
  dir = mkdtempSync(join(tmpdir(), "cli-keys-manage-store-"));
  project = mkdtempSync(join(tmpdir(), "cli-keys-manage-project-"));
  keyring = memoryKeyring();
  clock = fakeClock();
});

afterEach(async () => {
  await server.stop();
  rmSync(dir, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

/** What a person at a terminal is asked, and what they answer: `true` types the expected text. */
interface Asked {
  question: string;
  prompt: string;
  expected: string;
}

interface Run {
  /** A person at a terminal, who answers the confirmation as `answers` says. */
  person?: { answers: boolean };
  env?: NodeJS.ProcessEnv;
}

let asked: Asked[] = [];

function cli(args: string[], { person, env = {} }: Run = {}) {
  const fullEnv = cleanEnv({ HAAU3_PLATFORM_URL: server.url, ...env });
  const io = {
    store: testStore(dir, keyring, fullEnv),
    now: clock.now,
    sleep: clock.sleep,
    ...(person
      ? {
          stdin: { isTTY: true },
          confirm: async (question: string, prompt: string, expected: string) => {
            asked.push({ question, prompt, expected });
            return person.answers;
          },
        }
      : {}),
  };
  return runCli(args, { tty: person !== undefined, env: fullEnv, cwd: project, io });
}

const json = (text: string) => JSON.parse(text);

async function signIn() {
  asked = [];
  await cli(["login"]);
  expect((await cli(["login", "--complete"])).code).toBe(0);
}

/** Whether the session is still kept and the platform still takes it. */
async function stillSignedIn(): Promise<boolean> {
  return (await cli(["whoami"])).code === 0;
}

/** Revokes asked of the platform: never the sign-in service's own revocation endpoint. */
const isKeyRevoke = (path: string) => /^\/api\/cli\/v1\/keys\/[^/]+\/revoke$/.test(path);
const revokeCalls = () => server.requests.filter((r) => isKeyRevoke(r.path)).length;
const keyAt = (id: string) => server.listed.find((k) => k.id === id)!;

describe("keys list", () => {
  beforeEach(signIn);

  it("lists the organization's active keys, newest first as the platform gives them, and keeps the session", async () => {
    const out = await cli(["keys", "list"]);
    expect(out.code).toBe(0);
    const document = json(out.stdout);
    expect(document).toMatchObject({ formatVersion: "1.3", command: "keys list", ok: true, environment: null, error: null });
    expect(document.data.keys.map((k: { id: string }) => k.id)).toEqual([LISTED_KEY_ID, MANAGED_KEY_ID]);
    expect(document.data.keys[0]).toEqual({
      id: LISTED_KEY_ID,
      name: LISTED_NAME,
      prefix: LISTED_PREFIX,
      mode: "live",
      createdAt: "2026-11-10T12:00:00.000Z",
      createdVia: "cli",
      lastUsedAt: "2026-11-12T09:30:00.000Z",
      revokedAt: null,
      managed: false,
      inUse: null,
    });
    expect(document.data.keys[1]).toMatchObject({ managed: true, mode: "test" });
    expect(document.data).toMatchObject({ organization: { id: "org_1", name: "Example Org" }, hasMore: false, revokedOmitted: 1, projectKey: null });
    expect(document.data.next).toEqual([{ command: "npx haau3 keys list --all", description: "List the 1 revoked key too." }]);
    expect(server.to("/api/cli/v1/keys").at(-1)!.method).toBe("GET");
    expect(await stillSignedIn()).toBe(true);
  });

  it("includes the revoked keys with --all", async () => {
    const document = json((await cli(["keys", "list", "--all"])).stdout);
    expect(document.data.keys.map((k: { id: string }) => k.id)).toEqual([LISTED_KEY_ID, MANAGED_KEY_ID, REVOKED_KEY_ID]);
    expect(document.data.keys[2].revokedAt).toBe("2026-11-02T10:00:00.000Z");
    expect(document.data).toMatchObject({ revokedOmitted: 0, next: [] });
  });

  it("reads to a person at a terminal: each key's name, prefix, mode, dates, how it was made and its id", async () => {
    const out = await cli(["keys", "list"], { person: { answers: false } });
    expect(out.code).toBe(0);
    expect(out.stdout).toContain("Example Org: 2 active keys.");
    expect(out.stdout).toContain("laptop (made from the command line)");
    expect(out.stdout).toContain(`${LISTED_PREFIX}…  live`);
    expect(out.stdout).toContain(`Id: ${LISTED_KEY_ID}`);
    expect(out.stdout).toContain("Playground (managed)");
    expect(out.stdout).toContain("The dashboard's playgrounds use it. It cannot be revoked.");
    expect(out.stdout).toContain("Never used.");
    expect(out.stdout).toContain("1 revoked key is not shown.");
    expect(out.stdout).toContain("npx haau3 keys revoke <id> yourself, in a terminal");
    expect(out.stdout).not.toContain("old server");
  });

  it("marks the key this project uses, from its env file or the shell, by the part the keys page shows", async () => {
    writeFileSync(join(project, ".env"), `HAAU3_API_KEY=${listedKey()}\n`);
    let document = json((await cli(["keys", "list"])).stdout);
    expect(document.data.keys[0].inUse).toBe(".env");
    expect(document.data.keys[1].inUse).toBeNull();
    expect(document.data.projectKey).toEqual({ source: ".env", prefix: LISTED_PREFIX, listed: true });

    document = json((await cli(["keys", "list"], { env: { HAAU3_API_KEY: listedKey() } })).stdout);
    expect(document.data.keys[0].inUse).toBe("environment");
    const text = (await cli(["keys", "list"], { person: { answers: false } })).stdout;
    expect(text).toContain("This project uses it: .env.");
    // Nothing of the key past its prefix.
    expect(JSON.stringify(document) + text).not.toContain("ListedKeyRest");
  });

  it("says when the project's key is not among the listed keys: revoked, or another organization's", async () => {
    writeFileSync(join(project, ".env"), `HAAU3_API_KEY=${["haau3", "sk", "live", "Old123RestOfARevokedKeysFortyThreeCharsXYZ"].join("_")}\n`);
    let out = await cli(["keys", "list"], { person: { answers: false } });
    expect(out.stdout).toContain("This project's key (.env, starting haau3_sk_live_Old123) is not among this organization's active keys.");
    expect(out.stdout).toContain("It may have been revoked");
    expect(json((await cli(["keys", "list"])).stdout).data.projectKey).toEqual({ source: ".env", prefix: "haau3_sk_live_Old123", listed: false });
    // With --all the revoked key is listed, and marked.
    const all = json((await cli(["keys", "list", "--all"])).stdout);
    expect(all.data.keys[2].inUse).toBe(".env");
    expect(all.data.projectKey.listed).toBe(true);

    writeFileSync(join(project, ".env"), `HAAU3_API_KEY=${["haau3", "sk", "live", "Zzz999SomeoneElsesKeyFortyThreeCharactersXY"].join("_")}\n`);
    out = await cli(["keys", "list", "--all"], { person: { answers: false } });
    expect(out.stdout).toContain("is not among this organization's keys. It may be another organization's.");
  });

  it("marks nothing for a value that is not a haau3 key, and repeats none of it", async () => {
    writeFileSync(join(project, ".env"), "HAAU3_API_KEY=another-vendors-value-NOTAKEYVALUE\n");
    const out = await cli(["keys", "list"]);
    expect(json(out.stdout).data.projectKey).toBeNull();
    expect(out.stdout).not.toContain("NOTAKEYVALUE");
  });

  it("never shows a name that holds a key, and replaces what a terminal could act on", async () => {
    server.listed[0]!.name = `prod ${["haau3", "sk", "live", "NAMEDKEYMARKERrest"].join("_")}`;
    server.listed[1]!.name = "bad\u001b[31mname";
    const out = await cli(["keys", "list"], { person: { answers: false } });
    expect(out.stdout).toContain(HIDDEN_NAME);
    expect(out.stdout).not.toContain("NAMEDKEYMARKER");
    expect(out.stdout).not.toContain("\u001b");
    expect(out.stdout).toContain("bad�[31mname");
  });

  it.each([
    ["a list it cannot read", "garbled", 1, "unexpected-answer"],
    ["the platform down", "unavailable", 1, "platform-unavailable"],
    ["sign-in from the command line off", "off", 1, "sign-in-unavailable"],
    ["a refusal", "refused", 1, "unexpected-answer"],
  ] as [string, KeyReadAnswer, number, string][])("fails on %s, keeping the session", async (_, answer, code, error) => {
    server.listAnswer = answer;
    const out = await cli(["keys", "list"]);
    expect(out.code).toBe(code);
    expect(json(out.stdout).error.code).toBe(error);
    server.listAnswer = "ok";
    expect(await stillSignedIn()).toBe(true);
  });

  it("refuses a key whose prefix and mode disagree, as a list it cannot read", async () => {
    server.listed[0]!.mode = "test";
    expect(json((await cli(["keys", "list"])).stdout).error.code).toBe("unexpected-answer");
  });

  it.each([
    ["the platform no longer takes the session", "unauthorized", "session-ended"],
    ["the member left the organization", "not-a-member", "not-a-member"],
  ] as [string, KeyReadAnswer, string][])("ends the session when %s", async (_, answer, error) => {
    server.listAnswer = answer;
    const out = await cli(["keys", "list"]);
    expect(out.code).toBe(1);
    expect(json(out.stdout).error.code).toBe(error);
    server.listAnswer = "ok";
    expect(json((await cli(["whoami"])).stdout).error.code).toBe("not-signed-in");
  });
});

describe("keys list and keys revoke, signed out", () => {
  it("say so, and ask the platform nothing", async () => {
    for (const args of [["keys", "list"], ["keys", "revoke", LISTED_KEY_ID]]) {
      const out = await cli(args);
      expect(out.code).toBe(1);
      expect(json(out.stdout).error).toMatchObject({ code: "not-signed-in", next: [{ command: "npx haau3 login" }] });
    }
    expect(server.requests.filter((r) => r.path.startsWith("/api/cli/v1/keys"))).toEqual([]);
  });
});

describe("keys revoke's argument", () => {
  it.each([
    ["no id", [], "missing-argument"],
    ["a value that is not an id", ["not-an-id"], "invalid-id"],
    ["an API key typed in its place", [["haau3", "sk", "live", "TYPEDKEYMARKERabcdef"].join("_")], "invalid-id"],
    ["the key's prefix in its place", [LISTED_PREFIX], "invalid-id"],
  ])("refuses %s, sends nothing and repeats nothing", async (_, extra, error) => {
    await signIn();
    const before = server.requests.length;
    const out = await cli(["keys", "revoke", ...extra]);
    expect(out.code).toBe(2);
    expect(json(out.stdout).error).toMatchObject({ code: error, next: [{ command: "npx haau3 keys list" }] });
    expect(out.stdout + out.stderr).not.toContain("TYPEDKEYMARKER");
    expect(out.stdout).not.toContain("not-an-id");
    expect(server.requests.length).toBe(before);
  });

  it("takes one id, and no flag skips the question", async () => {
    let out = await cli(["keys", "revoke", LISTED_KEY_ID, REVOKED_KEY_ID]);
    expect(json(out.stdout).error).toMatchObject({ code: "unexpected-argument", message: "haau3 keys revoke takes one argument." });
    for (const flag of ["--yes", "--confirm", "--force", "-y"]) {
      out = await cli(["keys", "revoke", LISTED_KEY_ID, flag]);
      expect(out.code).toBe(2);
      expect(json(out.stdout).error.code).toMatch(/unknown-flag|invalid-flag/);
    }
  });
});

describe("keys revoke, with no terminal or when a coding agent runs it", () => {
  beforeEach(signIn);

  it("revokes nothing, names the key and the command to run in a terminal, and keeps the session", async () => {
    const out = await cli(["keys", "revoke", LISTED_KEY_ID]);
    expect(out.code).toBe(2);
    const document = json(out.stdout);
    expect(document).toMatchObject({ command: "keys revoke", ok: false, environment: "production" });
    expect(document.error.code).toBe("confirmation-needed");
    expect(document.error.message).toContain(LISTED_NAME);
    expect(document.error.message).toContain(LISTED_PREFIX);
    expect(document.error.message).toContain(`${server.url}/dashboard/keys`);
    expect(document.error.next).toEqual([{ command: `npx haau3 keys revoke ${LISTED_KEY_ID}`, description: expect.stringContaining("yourself in a terminal") }]);
    expect(revokeCalls()).toBe(0);
    expect(keyAt(LISTED_KEY_ID).revokedAt).toBeNull();
    expect(await stillSignedIn()).toBe(true);
  });

  it("refuses an agent given a terminal of its own, and asks it nothing", async () => {
    const out = await cli(["keys", "revoke", LISTED_KEY_ID], { person: { answers: true }, env: { CLAUDECODE: "1" } });
    expect(out.code).toBe(2);
    expect(json(out.stdout).error.code).toBe("confirmation-needed");
    expect(asked).toEqual([]);
    expect(revokeCalls()).toBe(0);
  });

  it("refuses a person who asked for JSON at a terminal, and asks nothing", async () => {
    const out = await cli(["keys", "revoke", LISTED_KEY_ID, "--json"], { person: { answers: true } });
    expect(json(out.stdout).error.code).toBe("confirmation-needed");
    expect(asked).toEqual([]);
  });

  it("says this project uses the key", async () => {
    writeFileSync(join(project, ".env"), `HAAU3_API_KEY=${listedKey()}\n`);
    const message = json((await cli(["keys", "revoke", LISTED_KEY_ID])).stdout).error.message;
    expect(message).toContain("This project uses it: .env.");
  });
});

describe("keys revoke, for a person at a terminal", () => {
  beforeEach(signIn);

  it("shows the key, asks for its name, revokes it, and ends the sign-in", async () => {
    const out = await cli(["keys", "revoke", LISTED_KEY_ID], { person: { answers: true } });
    expect(out.code).toBe(0);
    expect(asked).toHaveLength(1);
    expect(asked[0]!.expected).toBe(LISTED_NAME);
    expect(asked[0]!.prompt).toBe("Type the key's name to revoke it: ");
    expect(asked[0]!.question).toContain(`${LISTED_PREFIX}…  live`);
    expect(asked[0]!.question).toContain("cannot be brought back");
    expect(asked[0]!.question).toContain("Revoking ends this sign-in");
    expect(out.stdout).toContain(`Revoked ${LISTED_NAME} (${LISTED_PREFIX}) in Example Org.`);
    expect(revokeCalls()).toBe(1);
    const sent = server.requests.find((r) => isKeyRevoke(r.path))!;
    expect(sent).toMatchObject({ method: "POST", path: `/api/cli/v1/keys/${LISTED_KEY_ID}/revoke`, body: "" });
    expect(keyAt(LISTED_KEY_ID).revokedAt).not.toBeNull();
    // Revoking ended the sign-in: on the platform, and here.
    expect(server.revoked.length).toBeGreaterThan(0);
    expect(json((await cli(["whoami"])).stdout).error.code).toBe("not-signed-in");
  });

  it("answers as JSON too when the output is not text, after the person confirmed", async () => {
    // HAAU3_OUTPUT=json at a terminal is not a person at a terminal: refused, as any JSON caller is.
    const out = await cli(["keys", "revoke", LISTED_KEY_ID], { person: { answers: true }, env: { HAAU3_OUTPUT: "json" } });
    expect(json(out.stdout).error.code).toBe("confirmation-needed");
  });

  it("revokes nothing, and keeps the session, when the name is not typed", async () => {
    const out = await cli(["keys", "revoke", LISTED_KEY_ID], { person: { answers: false } });
    expect(out.code).toBe(1);
    expect(out.stderr).toContain("Nothing was revoked");
    expect(revokeCalls()).toBe(0);
    expect(keyAt(LISTED_KEY_ID).revokedAt).toBeNull();
    expect(await stillSignedIn()).toBe(true);
  });

  it("asks for the end of the prefix when the name holds what it will not print as it is", async () => {
    server.listed[0]!.name = "bad\u0007name";
    await cli(["keys", "revoke", LISTED_KEY_ID], { person: { answers: true } });
    expect(asked[0]!.expected).toBe("Lst123");
    expect(asked[0]!.prompt).toContain("Lst123, the end of its prefix");
  });

  it("asks for the end of the prefix when the name holds a key, and never shows it", async () => {
    server.listed[0]!.name = ["haau3", "sk", "live", "NAMEDKEYMARKERrest"].join("_");
    const out = await cli(["keys", "revoke", LISTED_KEY_ID], { person: { answers: true } });
    expect(asked[0]!.expected).toBe("Lst123");
    expect(asked[0]!.question + out.stdout + out.stderr).not.toContain("NAMEDKEYMARKER");
  });

  it("says when this project uses it, and after revoking it names the replacement", async () => {
    writeFileSync(join(project, ".env"), `HAAU3_API_KEY=${listedKey()}\n`);
    const out = await cli(["keys", "revoke", LISTED_KEY_ID], { person: { answers: true } });
    expect(asked[0]!.question).toContain("This project uses it: .env.");
    expect(out.stdout).toContain(".env still holds the revoked key");
    expect(out.stdout).toContain("npx haau3 keys create --replace");
    expect(out.stdout).toContain("npx haau3 login");
  });

  it("says the shell's variable still holds the key when the project uses it from there", async () => {
    const out = await cli(["keys", "revoke", LISTED_KEY_ID], { person: { answers: true }, env: { HAAU3_API_KEY: listedKey() } });
    expect(out.stdout).toContain("This shell's HAAU3_API_KEY still holds the revoked key");
  });

  it("refuses a managed key without asking, revoking or ending anything", async () => {
    const out = await cli(["keys", "revoke", MANAGED_KEY_ID], { person: { answers: true } });
    expect(out.code).toBe(1);
    expect(out.stderr).toContain("playground keys the dashboard keeps");
    expect(asked).toEqual([]);
    expect(revokeCalls()).toBe(0);
    expect(await stillSignedIn()).toBe(true);
  });

  it("says a key revoked already is, exits 0, and asks and spends nothing", async () => {
    const out = await cli(["keys", "revoke", REVOKED_KEY_ID], { person: { answers: true } });
    expect(out.code).toBe(0);
    expect(out.stdout).toContain("Already revoked on");
    expect(asked).toEqual([]);
    expect(revokeCalls()).toBe(0);
    const document = json((await cli(["keys", "revoke", REVOKED_KEY_ID])).stdout);
    expect(document).toMatchObject({ ok: true, data: { status: "already-revoked", signInEnded: false, key: { id: REVOKED_KEY_ID } } });
    expect(await stillSignedIn()).toBe(true);
  });

  it("says the organization has no such key, keeping the session", async () => {
    const out = await cli(["keys", "revoke", UNKNOWN_KEY_ID]);
    expect(out.code).toBe(1);
    expect(json(out.stdout).error).toMatchObject({ code: "key-not-found", next: [{ command: "npx haau3 keys list" }] });
    expect(await stillSignedIn()).toBe(true);
  });

  it("takes an id in capitals, and sends it as the platform writes it", async () => {
    await cli(["keys", "revoke", LISTED_KEY_ID.toUpperCase()], { person: { answers: true } });
    expect(server.requests.find((r) => isKeyRevoke(r.path))!.path).toBe(`/api/cli/v1/keys/${LISTED_KEY_ID}/revoke`);
  });

  it.each([
    ["another request revoked it first", "raced", 0, null, true],
    ["the key went meanwhile", "gone", 1, "key-not-found", true],
    ["the platform failed after ending the sign-in", "unavailable", 1, "platform-unavailable", true],
    ["no answer came", "no-answer", 1, "platform-unreachable", true],
    ["a success it cannot read", "garbled", 1, "unexpected-answer", true],
    ["the platform no longer takes the session", "unauthorized", 1, "session-ended", true],
    ["the member left the organization", "not-a-member", 1, "not-a-member", true],
    ["a refusal that spends nothing", "refused", 1, "unexpected-answer", false],
    ["sign-in from the command line off", "off", 1, "sign-in-unavailable", false],
  ] as [string, RevokeKeyAnswer, number, string | null, boolean][])("when %s, says so, and ends the session only when the sign-in may be spent", async (_, answer, code, error, ended) => {
    server.revokeKeyAnswer = answer;
    const out = await cli(["keys", "revoke", LISTED_KEY_ID, "--json"], { person: { answers: true } });
    // JSON at a terminal is refused before asking, so the person's run is the text one.
    expect(json(out.stdout).error.code).toBe("confirmation-needed");
    const text = await cli(["keys", "revoke", LISTED_KEY_ID], { person: { answers: true } });
    expect(text.code).toBe(code);
    if (error) expect(text.stderr).not.toBe("");
    if (answer === "unavailable" || answer === "no-answer" || answer === "garbled") {
      // Whether the key was revoked is not known: the keys page says.
      expect(text.stderr).toMatch(/may (or may not )?have (been )?revoked/);
      expect(text.stderr).toContain(`${server.url}/dashboard/keys`);
      expect(text.stderr).toContain("sign in again before trying again");
    }
    server.revokeKeyAnswer = "revoked";
    const after = await cli(["whoami"]);
    expect(after.code === 0).toBe(!ended);
  });
});

describe("the typed confirmation", () => {
  it("ignores case and the spaces around the name, and nothing else", () => {
    expect(sameText("  Laptop ", "laptop")).toBe(true);
    expect(sameText("lap top", "laptop")).toBe(false);
    expect(sameText("", "")).toBe(false);
    expect(sameText("CAFÉ", "café")).toBe(true);
  });

  /** A person who types each line when the prompt shows, as one at a terminal does, then ends the input if `end`. */
  async function answering(lines: string[], end = false) {
    const stdin = new PassThrough() as unknown as NodeJS.ReadStream & PassThrough;
    const stdout = new PassThrough() as unknown as NodeJS.WriteStream & PassThrough;
    const prompt = "Type the key's name to revoke it: ";
    const left = [...lines];
    let shown = "";
    stdout.on("data", (chunk: Buffer) => {
      shown += chunk.toString("utf8");
      if (!chunk.toString("utf8").includes(prompt)) return;
      const line = left.shift();
      if (line !== undefined) stdin.write(`${line}\n`);
      else if (end) stdin.end();
    });
    const confirmed = await confirmOnTerminal(stdin, stdout)("Revoke laptop?", prompt, "laptop");
    return { confirmed, shown, left };
  }

  it("confirms on the name, after a wrong answer", async () => {
    const { confirmed, shown } = await answering(["nope", "LAPTOP"]);
    expect(confirmed).toBe(true);
    expect(shown).toContain("That does not match.");
  });

  it("refuses after three wrong answers, and asks no fourth time", async () => {
    const { confirmed, left } = await answering(["a", "b", "c", "laptop"]);
    expect(confirmed).toBe(false);
    expect(left).toEqual(["laptop"]);
  });

  it("refuses when the input ends, as Ctrl-D ends it", async () => {
    expect((await answering([], true)).confirmed).toBe(false);
  });
});
