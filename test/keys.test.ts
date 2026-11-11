// haau3 keys create against a stand-in platform, in real folders and real git repositories: where the
// key goes, every refusal before a key is made (none of which asks the platform for one), every answer
// the platform can give, and what is printed, which is never the key.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NAME_MAX } from "../src/commands/keys.js";
import { ACCESS_TOKEN, FakeServer, NEW_KEY_MARKERS, newKey, newKeyPrefix, type KeysAnswer } from "./fake-server.js";
import { cleanEnv, fakeClock, memoryKeyring, runCli, testStore } from "./helpers.js";

let server: FakeServer;
let dir: string;
let project: string;
let keyring: ReturnType<typeof memoryKeyring>;
let clock: ReturnType<typeof fakeClock>;

beforeEach(async () => {
  server = await new FakeServer().start();
  dir = mkdtempSync(join(tmpdir(), "cli-keys-store-"));
  project = mkdtempSync(join(tmpdir(), "cli-keys-project-"));
  keyring = memoryKeyring();
  clock = fakeClock();
});

afterEach(async () => {
  await server.stop();
  rmSync(dir, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

interface Run {
  tty?: boolean;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

/** Runs the command line in the project, against the stand-in, with git on PATH as it is here. */
function cli(args: string[], { tty = false, env = {}, cwd = project }: Run = {}) {
  const fullEnv = cleanEnv({ HAAU3_PLATFORM_URL: server.url, ...env });
  return runCli(args, { tty, env: fullEnv, cwd, io: { store: testStore(dir, keyring, fullEnv), now: clock.now, sleep: clock.sleep } });
}

const json = (text: string) => JSON.parse(text);

async function signIn() {
  await cli(["login"]);
  expect((await cli(["login", "--complete"])).code).toBe(0);
}

function git(...args: string[]) {
  execFileSync("git", args, { cwd: project, stdio: "ignore" });
}

const read = (name: string) => readFileSync(join(project, name), "utf8");
const keyCalls = () => server.to("/api/cli/v1/keys").length;

/** Throws, without repeating it, when `text` holds any part of the new key past its prefix. */
function assertNoKey(text: string) {
  const hit = NEW_KEY_MARKERS.findIndex((m) => text.includes(m));
  if (hit !== -1) throw new Error(`printed new-key marker number ${hit}`);
}

describe("keys create, signed in", () => {
  beforeEach(signIn);

  it("makes a live key and writes it to a new .env when the project has no env file", async () => {
    const out = await cli(["keys", "create"]);
    assertNoKey(out.stdout + out.stderr);
    expect(out.code).toBe(0);
    const document = json(out.stdout);
    expect(document).toMatchObject({ formatVersion: "1.2", command: "keys create", ok: true, environment: "production", error: null });
    expect(document.data).toMatchObject({
      status: "created",
      key: { id: "key_fake_1", prefix: newKeyPrefix("live"), mode: "live" },
      organization: { id: "org_1", name: "Example Org" },
      envFile: { path: ".env", created: true, gitRepository: false },
      replaced: null,
      next: [{ command: "npx haau3 whoami", description: expect.any(String) }],
    });
    expect(document.data.warnings.map((w: { code: string }) => w.code)).toEqual(["no-git-repository"]);
    expect(read(".env")).toBe(`HAAU3_API_KEY=${newKey("live")}\n`);
    if (process.platform !== "win32") expect(statSync(join(project, ".env")).mode & 0o777).toBe(0o600);

    const [call] = server.to("/api/cli/v1/keys");
    expect(call!.method).toBe("POST");
    expect(call!.headers.authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(call!.headers["content-type"]).toBe("application/json");
    const sent = json(call!.body);
    expect(sent.mode).toBe("live");
    expect(sent.name).toMatch(/^haau3 CLI: cli-keys-project-\w+, \d{4}-\d{2}-\d{2}$/);
  });

  it("makes a test key with --test, for the Sandbox", async () => {
    const out = await cli(["keys", "create", "--test"], { tty: true });
    assertNoKey(out.stdout + out.stderr);
    expect(out.code).toBe(0);
    expect(out.stdout).toContain("Made a test key in Example Org");
    expect(out.stdout).toContain(`  Prefix: ${newKeyPrefix("test")}`);
    expect(out.stdout).toContain("  Id:     key_fake_1");
    expect(out.stdout).toContain("A test key reaches the Sandbox only.");
    expect(out.stdout).toContain("Next:\n  npx haau3 whoami\n");
    expect(read(".env")).toBe(`HAAU3_API_KEY=${newKey("test")}\n`);
    expect(json(server.to("/api/cli/v1/keys")[0]!.body).mode).toBe("test");
    expect(json((await cli(["keys", "create", "--test", "--replace"])).stdout).environment).toBe("sandbox");
  });

  it("names the key with --name, and refuses a name that holds a key without repeating it", async () => {
    expect((await cli(["keys", "create", "--name", "Billing worker"])).code).toBe(0);
    expect(json(server.to("/api/cli/v1/keys")[0]!.body).name).toBe("Billing worker");

    const pasted = ["haau3", "sk", "live", "SOMEONEPASTEDTHIS123456"].join("_");
    for (const name of [pasted, "", " ", "x".repeat(NAME_MAX + 1), "bell\u0007"]) {
      const out = await cli(["keys", "create", "--replace", `--name=${name}`]);
      expect(out.code).toBe(2);
      expect(json(out.stdout).error.code).toBe("invalid-name");
      expect(out.stdout).not.toContain("SOMEONEPASTED");
    }
    expect(keyCalls()).toBe(1);
  });

  it("writes .env.local for a Next.js or Vite project", async () => {
    for (const framework of ["next", "vite"]) {
      rmSync(join(project, ".env.local"), { force: true });
      writeFileSync(join(project, "package.json"), JSON.stringify({ dependencies: framework === "next" ? { next: "16.0.0" } : {}, devDependencies: framework === "vite" ? { vite: "7.0.0" } : {} }));
      const out = await cli(["keys", "create"]);
      expect(json(out.stdout).data.envFile.path).toBe(".env.local");
      expect(existsSync(join(project, ".env"))).toBe(false);
    }
  });

  it("writes to the file that holds the key, and replaces it only with --replace", async () => {
    const old = ["haau3", "sk", "live", `Old987${"z".repeat(30)}`].join("_");
    writeFileSync(join(project, ".env.local"), "OTHER=1\n");
    writeFileSync(join(project, ".env"), `# keys\nHAAU3_API_KEY=${old}\nPORT=3000\n`);

    const refused = await cli(["keys", "create"]);
    expect(refused.code).toBe(1);
    const error = json(refused.stdout).error;
    expect(error.code).toBe("key-exists");
    expect(error.message).toContain(".env already holds HAAU3_API_KEY (a key starting haau3_sk_live_Old987)");
    expect(error.next[0].command).toBe("npx haau3 keys create --replace");
    expect(refused.stdout).not.toContain(old);
    expect(keyCalls()).toBe(0);

    if (process.platform !== "win32") chmodSync(join(project, ".env"), 0o640);
    const out = await cli(["keys", "create", "--replace"]);
    expect(out.code).toBe(0);
    // Written in place: the file keeps its own permissions, as a file put in its place would not.
    if (process.platform !== "win32") expect(statSync(join(project, ".env")).mode & 0o777).toBe(0o640);
    expect(json(out.stdout).data.replaced).toEqual({ prefix: "haau3_sk_live_Old987" });
    expect(out.stdout).not.toContain(old);
    expect(read(".env")).toBe(`# keys\nHAAU3_API_KEY=${newKey("live")}\nPORT=3000\n`);
    expect(read(".env.local")).toBe("OTHER=1\n");
  });

  it("fills a blank HAAU3_API_KEY, as an example file leaves it, without --replace", async () => {
    writeFileSync(join(project, ".env"), "HAAU3_API_KEY=\nPORT=3000\n");
    const out = await cli(["keys", "create"]);
    expect(out.code).toBe(0);
    expect(json(out.stdout).data.replaced).toBeNull();
    expect(read(".env")).toBe(`HAAU3_API_KEY=${newKey("live")}\nPORT=3000\n`);
  });

  it("writes to --env-file, which must name an env file, and says when the defaults will not read it", async () => {
    const out = await cli(["keys", "create", "--env-file", "prod.env"]);
    expect(out.code).toBe(0);
    const data = json(out.stdout).data;
    expect(data.envFile.path).toBe("prod.env");
    expect(data.warnings.map((w: { code: string }) => w.code)).toContain("env-file-not-default");
    expect(read("prod.env")).toBe(`HAAU3_API_KEY=${newKey("live")}\n`);

    const pasted = ["haau3", "sk", "live", "SOMEONEPASTEDTHIS123456"].join("_");
    for (const name of ["config.json", "env", pasted, `.env${pasted}`, "notes.txt"]) {
      const refused = await cli(["keys", "create", `--env-file=${name}`]);
      expect(refused.code).toBe(2);
      expect(json(refused.stdout).error.code).toBe("invalid-env-file");
      expect(refused.stdout).not.toContain("SOMEONEPASTED");
      expect(refused.stdout).not.toContain("config.json");
    }
    expect(keyCalls()).toBe(1);
  });

  it("warns when the shell already holds a key, which applications read first", async () => {
    const shell = ["haau3", "sk", "live", "SHELLKEY0123456789abcdef"].join("_");
    const out = await cli(["keys", "create"], { env: { HAAU3_API_KEY: shell } });
    expect(out.code).toBe(0);
    expect(json(out.stdout).data.warnings.map((w: { code: string }) => w.code)).toContain("shell-key");
    expect(out.stdout).not.toContain(shell);
  });

  it("refuses the home folder, unless a file is named", async () => {
    const out = await cli(["keys", "create"], { env: { HOME: project, USERPROFILE: project } });
    expect(out.code).toBe(2);
    expect(json(out.stdout).error.code).toBe("not-a-project");
    expect(keyCalls()).toBe(0);
    expect((await cli(["keys", "create", "--env-file", ".env"], { env: { HOME: project, USERPROFILE: project } })).code).toBe(0);
  });

  it.skipIf(process.platform === "win32")("refuses a symbolic link, which can lead to a file git keeps", async () => {
    writeFileSync(join(project, "real.env"), "A=1\n");
    symlinkSync(join(project, "real.env"), join(project, ".env"));
    const out = await cli(["keys", "create"]);
    expect(json(out.stdout).error.code).toBe("env-file-symlink");
    expect(read("real.env")).toBe("A=1\n");
    expect(keyCalls()).toBe(0);
  });

  it("refuses a folder named like an env file, and a file too large to be one", async () => {
    mkdirSync(join(project, ".env"));
    expect(json((await cli(["keys", "create"])).stdout).error.code).toBe("env-file-not-a-file");
    rmSync(join(project, ".env"), { recursive: true });
    writeFileSync(join(project, ".env"), `A=${"x".repeat(1024 * 1024)}\n`);
    expect(json((await cli(["keys", "create"])).stdout).error.code).toBe("env-file-too-large");
    expect(keyCalls()).toBe(0);
  });
});

describe("keys create in a git repository", () => {
  beforeEach(async () => {
    git("init", "-q");
    await signIn();
  });

  it("writes to a file git ignores, with no warning", async () => {
    writeFileSync(join(project, ".gitignore"), ".env\n");
    const out = await cli(["keys", "create"]);
    expect(out.code).toBe(0);
    const data = json(out.stdout).data;
    expect(data.envFile).toEqual({ path: ".env", created: true, gitRepository: true });
    expect(data.warnings).toEqual([]);
  });

  it("refuses a file git does not ignore, with the line to add, and asks the platform for nothing", async () => {
    writeFileSync(join(project, "package.json"), JSON.stringify({ devDependencies: { vite: "7.0.0" } }));
    const out = await cli(["keys", "create"]);
    expect(out.code).toBe(1);
    const document = json(out.stdout);
    expect(document.formatVersion).toBe("1.2");
    expect(document.error).toMatchObject({ code: "env-file-not-ignored", gitignore: { file: ".gitignore", line: ".env.local" } });
    expect(document.error.message).toContain("Add this line to .gitignore, then run this again:\n  .env.local");
    expect(document.error.next[0].command).toBe("npx haau3 keys create");
    expect(existsSync(join(project, ".env.local"))).toBe(false);
    expect(keyCalls()).toBe(0);

    const text = await cli(["keys", "create"], { tty: true });
    expect(text.stderr).toContain("git does not ignore .env.local");
  });

  it("refuses a file git tracks even when .gitignore names it, and says how to stop tracking it", async () => {
    writeFileSync(join(project, ".env"), "PORT=3000\n");
    git("add", ".env");
    writeFileSync(join(project, ".gitignore"), ".env\n");
    const out = await cli(["keys", "create"]);
    const error = json(out.stdout).error;
    expect(error.code).toBe("env-file-tracked");
    expect(error.message).toContain("git rm --cached .env");
    expect(error.gitignore).toEqual({ file: ".gitignore", line: ".env" });
    expect(read(".env")).toBe("PORT=3000\n");
    expect(keyCalls()).toBe(0);
  });

  it("refuses when the repository has no git to ask", async () => {
    const out = await cli(["keys", "create"], { env: { PATH: "", Path: "" } });
    expect(json(out.stdout).error.code).toBe("git-unavailable");
    expect(keyCalls()).toBe(0);
  });

  it("checks the named file's own folder, and names that folder's .gitignore", async () => {
    mkdirSync(join(project, "app"));
    const out = await cli(["keys", "create", "--env-file", join("app", ".env")]);
    expect(json(out.stdout).error.gitignore).toEqual({ file: join("app", ".gitignore"), line: ".env" });
    writeFileSync(join(project, "app", ".gitignore"), ".env\n");
    expect((await cli(["keys", "create", "--env-file", join("app", ".env")])).code).toBe(0);
  });
});

describe("keys create and the session", () => {
  it("says to sign in when there is no session, and asks nothing of the platform", async () => {
    const out = await cli(["keys", "create"]);
    expect(out.code).toBe(1);
    expect(json(out.stdout).error).toMatchObject({ code: "not-signed-in", next: [{ command: "npx haau3 login" }] });
    expect(keyCalls()).toBe(0);
    expect(existsSync(join(project, ".env"))).toBe(false);
  });

  it("ends a session whose hour is over and says to sign in again", async () => {
    await signIn();
    await clock.sleep(61 * 60_000);
    const out = await cli(["keys", "create"]);
    expect(json(out.stdout).error.code).toBe("session-ended");
    expect(server.revoked).toContain(ACCESS_TOKEN);
    expect(keyring.entries.has(server.url)).toBe(false);
    expect(keyCalls()).toBe(0);
  });

  it.each([
    ["unauthorized", "session-ended"],
    ["not-a-member", "not-a-member"],
    ["no-organization", "no-organization"],
  ] as const)("ends the session when the platform answers %s", async (answer, code) => {
    await signIn();
    server.keysAnswer = answer;
    const out = await cli(["keys", "create"]);
    expect(json(out.stdout).error.code).toBe(code);
    expect(server.revoked).toContain(ACCESS_TOKEN);
    expect(keyring.entries.has(server.url)).toBe(false);
    expect(existsSync(join(project, ".env"))).toBe(false);
  });

  it("keeps the session when the platform cannot answer just now", async () => {
    await signIn();
    server.keysAnswer = "unavailable";
    const out = await cli(["keys", "create"]);
    expect(json(out.stdout).error).toMatchObject({ code: "platform-unavailable", problem: { status: 503, code: "unavailable" } });
    expect(server.revoked).toEqual([]);
    expect(keyring.entries.has(server.url)).toBe(true);
  });

  it("says sign-in from the command line is not open when the platform answers 404", async () => {
    await signIn();
    server.keysAnswer = "off";
    const out = await cli(["keys", "create"]);
    const error = json(out.stdout).error;
    expect(error.code).toBe("sign-in-unavailable");
    expect(error.message).toContain(`${server.url}/dashboard/keys`);
  });
});

describe("keys create when the answer cannot be used", () => {
  beforeEach(signIn);

  it.each(["garbled", "wrong-mode", "bad-secret"] as KeysAnswer[])("writes nothing for a key answered %s, and says to revoke it", async (answer) => {
    server.keysAnswer = answer;
    writeFileSync(join(project, ".env"), "PORT=3000\n");
    const out = await cli(["keys", "create"]);
    assertNoKey(out.stdout + out.stderr);
    expect(out.stdout).not.toContain("EVIL");
    const error = json(out.stdout).error;
    expect(error.code).toBe("unexpected-answer");
    expect(error.message).toContain("/dashboard/keys");
    expect(read(".env")).toBe("PORT=3000\n");
  });

  it("says a key may have been made when no answer comes", async () => {
    server.keysAnswer = "no-answer";
    const out = await cli(["keys", "create"]);
    const error = json(out.stdout).error;
    expect(error.code).toBe("platform-unreachable");
    expect(error.message).toContain("A key may have been made");
    expect(existsSync(join(project, ".env"))).toBe(false);
  });

  it("says the key was made and names it when the file cannot be written after all", async () => {
    writeFileSync(join(project, ".env"), "PORT=3000\n");
    server.onKeys = () => {
      rmSync(join(project, ".env"));
      mkdirSync(join(project, ".env"));
    };
    const out = await cli(["keys", "create"]);
    assertNoKey(out.stdout + out.stderr);
    expect(out.code).toBe(1);
    const error = json(out.stdout).error;
    expect(error.code).toBe("write-failed");
    expect(error.message).toContain("The key was made, but .env could not be written");
    expect(error.message).toContain(newKeyPrefix("live"));
    expect(error.message).toContain("key_fake_1");
    expect(error.message).toContain(`${server.url}/dashboard/keys`);
    // No copy of the key was left anywhere in the project on the way.
    const left = readdirSync(project, { recursive: true, withFileTypes: true }).filter((e) => e.isFile());
    for (const entry of left) assertNoKey(readFileSync(join(entry.parentPath, entry.name), "utf8"));
  });

  it("does not overwrite a key written to the file while the platform was asked", async () => {
    writeFileSync(join(project, ".env"), "PORT=3000\n");
    const other = ["haau3", "sk", "live", `Zzz999${"q".repeat(30)}`].join("_");
    server.onKeys = () => writeFileSync(join(project, ".env"), `HAAU3_API_KEY=${other}\n`);
    const out = await cli(["keys", "create"]);
    expect(json(out.stdout).error.code).toBe("write-failed");
    expect(read(".env")).toBe(`HAAU3_API_KEY=${other}\n`);
  });
});

describe("keys create's arguments", () => {
  it("needs its second word, and takes no more", async () => {
    expect(json((await cli(["keys"])).stdout).error).toMatchObject({ code: "missing-command", message: "haau3 keys needs a command: keys create." });
    expect(json((await cli(["keys", "nope"])).stdout).error.message).toBe("haau3 keys has no command named nope. It has keys create.");
    const out = await cli(["keys", "create", "extra"]);
    expect(out.code).toBe(2);
    expect(json(out.stdout).error).toMatchObject({ code: "unexpected-argument", message: "haau3 keys create takes no arguments." });
  });

  it("says when a flag needs a value, and when another command's flag is given", async () => {
    for (const args of [["keys", "create", "--name"], ["keys", "create", "--env-file", "--test"]]) {
      const out = await cli(args);
      expect(out.code).toBe(2);
      expect(json(out.stdout).error.code).toBe("missing-value");
    }
    expect(json((await cli(["login", "--name", "x"])).stdout).error).toMatchObject({ code: "unknown-flag", message: "haau3 has no flag --name." });
    expect(json((await cli(["keys", "create", "--test=yes"])).stdout).error).toMatchObject({ code: "invalid-flag", message: "--test takes no value." });
    expect(keyCalls()).toBe(0);
  });
});
