// What the command line prints and how it exits, for everything 0.1 accepts and refuses.
import { describe, expect, it } from "vitest";
import { HELP } from "../src/help.js";
import { VERSION } from "../src/version.js";
import { runCli, spawnCli } from "./helpers.js";

const json = (text: string) => JSON.parse(text);

describe("help", () => {
  it.each([[[]], [["--help"]], [["-h"]], [["help"]], [["help", "anything"]]])("%j prints help as text and exits 0", async (args) => {
    for (const tty of [true, false]) {
      const out = await runCli(args, { tty });
      expect(out.code).toBe(0);
      expect(out.stdout).toContain("Usage: haau3 [command] [options]");
      expect(out.stdout).toContain("HAAU3_OUTPUT");
      expect(out.stderr).toBe("");
    }
  });

  it("stays text when Codex runs it: the automatic switch leaves help alone", async () => {
    const out = await runCli(["--help"], { tty: true, env: { CODEX_SANDBOX: "seatbelt" } });
    expect(out.stdout).toContain("Usage: haau3");
  });

  it("is a JSON document when asked for, by --json or HAAU3_OUTPUT", async () => {
    for (const [args, env] of [[["--help", "--json"], {}], [["--help"], { HAAU3_OUTPUT: "json" }], [[], { HAAU3_OUTPUT: "json" }]] as const) {
      const out = await runCli([...args], { tty: true, env });
      const document = json(out.stdout);
      expect(out.code).toBe(0);
      expect(document).toMatchObject({ formatVersion: "1.3", command: "help", ok: true, environment: null, error: null });
      expect(document.data).toEqual(HELP);
    }
  });

  it("lists every option the parser takes", async () => {
    expect(HELP.options.map((o) => o.name)).toEqual(["--json", "-h, --help", "--version"]);
  });

  it("lists every command, and every variable the commands read", async () => {
    expect(HELP.commands.map((c) => c.name)).toEqual([
      "doctor",
      "doctor --file <file>",
      "login",
      "login --complete",
      "whoami",
      "logout",
      "keys create",
      "keys create --test",
      "keys create --name <name>",
      "keys create --file <file>",
      "keys create --replace",
    ]);
    expect(HELP.environment.map((e) => e.name)).toEqual([
      "HAAU3_API_KEY",
      "HAAU3_ENVIRONMENT",
      "HAAU3_BASE_URL",
      "HAAU3_OUTPUT",
      "HAAU3_PLATFORM_URL",
      "HAAU3_SESSION_STORE",
      "HAAU3_CONFIG_DIR",
    ]);
    const text = (await runCli(["--help"])).stdout;
    expect(text).toContain("Commands:\n  doctor ");
    for (const entry of [...HELP.commands, ...HELP.environment]) expect(text).toContain(entry.description);
  });
});

describe("version", () => {
  it("prints the bare version, terminal or not, and exits 0", async () => {
    for (const tty of [true, false]) {
      const out = await runCli(["--version"], { tty });
      expect(out).toEqual({ code: 0, stdout: `${VERSION}\n`, stderr: "" });
    }
  });

  it("wins over a command and over --help", async () => {
    expect((await runCli(["no-such-command", "--version"])).stdout).toBe(`${VERSION}\n`);
    expect((await runCli(["--help", "--version"])).stdout).toBe(`${VERSION}\n`);
  });

  it("is a JSON document when asked for", async () => {
    const out = await runCli(["--version", "--json"], { tty: true });
    expect(json(out.stdout)).toEqual({
      formatVersion: "1.3",
      cli: "haau3",
      cliVersion: VERSION,
      command: "version",
      ok: true,
      environment: null,
      data: { version: VERSION },
      error: null,
    });
  });
});

describe("a usage error", () => {
  it("is one JSON document on stdout, exit 2, when output is not a terminal", async () => {
    const out = await runCli(["nope"]);
    expect(out.code).toBe(2);
    expect(out.stderr).toBe("");
    expect(json(out.stdout)).toEqual({
      formatVersion: "1.3",
      cli: "haau3",
      cliVersion: VERSION,
      command: null,
      ok: false,
      environment: null,
      data: null,
      error: {
        code: "unknown-command",
        message: "haau3 has no command named nope.",
        next: [{ command: "npx haau3 --help", description: "See what haau3 can do." }],
      },
    });
  });

  it("is text on stderr, exit 2, at a terminal", async () => {
    const out = await runCli(["nope"], { tty: true });
    expect(out.code).toBe(2);
    expect(out.stdout).toBe("");
    expect(out.stderr).toBe("haau3 has no command named nope.\n\nNext:\n  npx haau3 --help\n    See what haau3 can do.\n");
  });

  it("follows Codex's markers and HAAU3_OUTPUT", async () => {
    expect(json((await runCli(["nope"], { tty: true, env: { CODEX_THREAD_ID: "t" } })).stdout).error.code).toBe("unknown-command");
    expect((await runCli(["nope"], { tty: false, env: { HAAU3_OUTPUT: "text" } })).stderr).toContain("no command named nope");
  });

  it("repeats a command back only when it has a command's shape", async () => {
    for (const odd of ["Nope", "no_such", "a/b", "x".repeat(60), "two words", "--"]) {
      const out = await runCli(odd === "--" ? ["--", "x y"] : [odd]);
      const document = json(out.stdout);
      expect(document.error.code).toBe("unknown-command");
      expect(document.error.message).toBe("haau3 has no such command.");
    }
  });

  it("names an unknown flag, never a value after its =", async () => {
    expect(json((await runCli(["--nope"])).stdout).error).toMatchObject({ code: "unknown-flag", message: "haau3 has no flag --nope." });
    expect(json((await runCli(["--nope=value123"])).stdout).error.message).toBe("haau3 has no flag --nope.");
    expect(json((await runCli(["-x"])).stdout).error.message).toBe("haau3 has no flag -x.");
    expect(json((await runCli(["--no_pe"])).stdout).error.message).toBe("haau3 has no such flag.");
  });

  it("refuses a value given to a flag that takes none", async () => {
    const out = await runCli(["--json=yes"]);
    expect(out.code).toBe(2);
    expect(json(out.stdout).error).toMatchObject({ code: "invalid-flag" });
  });
});

describe("an error of its own", () => {
  it("is reported by its name only, exit 1, never by its message", async () => {
    let reads = 0;
    // The first read of the environment throws, carrying text that must not be printed.
    const env = new Proxy({} as NodeJS.ProcessEnv, {
      get(_, name) {
        if (reads++ === 0) throw new TypeError(`could not read ${String(name)}: secret-detail-123`);
        return undefined;
      },
    });
    let stdout = "";
    const { main } = await import("../src/main.js");
    const code = await main(["--help"], { stdout: { isTTY: false, write: (t: string) => (stdout += t) }, stderr: { write: () => true }, env, cwd: "." });
    expect(code).toBe(1);
    const document = JSON.parse(stdout);
    expect(document.error.code).toBe("internal-error");
    expect(document.error.message).toBe("haau3 stopped on an error of its own (TypeError).");
    expect(stdout).not.toContain("secret-detail-123");
  });
});

describe("as a process", () => {
  it("prints its version", () => {
    expect(spawnCli(["--version"])).toEqual({ code: 0, stdout: `${VERSION}\n`, stderr: "" });
  });

  it("answers an unknown command with one JSON document and exit 2, its stdout being a pipe", () => {
    const out = spawnCli(["nope"]);
    expect(out.code).toBe(2);
    expect(JSON.parse(out.stdout).error.code).toBe("unknown-command");
  });
});
