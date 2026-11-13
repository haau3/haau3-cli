// haau3 init: what it sets up in each kind of project, that it writes no application code, that a
// second run changes nothing, that with no terminal it asks nothing and names the flag for a choice it
// cannot make, and that it leaves the person's own files as they were when it cannot be sure.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { InitCheck, InitCheckName } from "../src/commands/init.js";
import { findGit } from "../src/git.js";
import { FakeDocs, filesIn, pathOf, SKILL, standIns, type StandIns } from "./init-helpers.js";
import { runCli, type Extra } from "./helpers.js";

const ALL = ["npm", "pnpm", "yarn", "bun", "uv", "poetry", "pipenv", "go"];

let project: string;
let home: string;
let docs: FakeDocs;
let managers: StandIns;
let gitFolder: string;

beforeEach(async () => {
  project = mkdtempSync(join(tmpdir(), "cli-init-"));
  home = mkdtempSync(join(tmpdir(), "cli-init-home-"));
  docs = await new FakeDocs().start();
  managers = standIns(ALL);
  const git = findGit(process.env, project);
  if (!git) throw new Error("these tests need git on PATH");
  gitFolder = dirname(git);
});
afterEach(async () => {
  await docs.stop();
  rmSync(project, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  rmSync(dirname(managers.bin), { recursive: true, force: true });
});

function write(name: string, text: string): void {
  mkdirSync(dirname(join(project, name)), { recursive: true });
  writeFileSync(join(project, name), text);
}

function read(name: string): string {
  return readFileSync(join(project, name), "utf8");
}

function git(...args: string[]): void {
  execFileSync(join(gitFolder, process.platform === "win32" ? "git.exe" : "git"), args, { cwd: project, stdio: "ignore" });
}

interface Run {
  env?: NodeJS.ProcessEnv;
  tty?: boolean;
  io?: Extra;
  path?: string;
}

function environment(extra: NodeJS.ProcessEnv = {}, path = pathOf(managers.bin, gitFolder)): NodeJS.ProcessEnv {
  return {
    PATH: path,
    SystemRoot: process.env.SystemRoot,
    HOME: home,
    USERPROFILE: home,
    STANDIN_LOG: managers.log,
    HAAU3_DOCS_URL: docs.url,
    ...extra,
  };
}

async function init(args: string[] = [], { env = {}, tty = false, io = {}, path }: Run = {}) {
  const out = await runCli(["init", ...args], { cwd: project, tty, env: environment(env, path), io });
  return { ...out, document: tty && !args.includes("--json") ? null : JSON.parse(out.stdout) };
}

const checksOf = (document: { data: { checks: InitCheck[] } }) => Object.fromEntries(document.data.checks.map((c) => [c.name, c])) as Record<InitCheckName, InitCheck>;

/** The files a setup may write, beside the manifests and lockfiles. */
const AGENT_FILES = [".claude/skills/haau3/SKILL.md", ".agents/skills/haau3/SKILL.md", ".mcp.json", ".cursor/mcp.json", ".vscode/mcp.json", ".gemini/settings.json", ".codex/config.toml"];

describe("an npm project", () => {
  it("gets the SDK through npm, the skill and the MCP entry, writes nothing else, and changes nothing the second time", async () => {
    write("package.json", JSON.stringify({ name: "app", version: "1.0.0" }, null, 2));
    const before = filesIn(project);
    const first = await init(["--agent", "claude-code", "--agent", "codex"]);
    expect(first.code).toBe(0);
    expect(first.document).toMatchObject({ formatVersion: "1.3", command: "init", ok: true, environment: null, error: null });
    expect(managers.calls()).toEqual([{ name: "npm", args: ["install", "@haau3/sdk"], cwd: expect.any(String) }]);
    expect(JSON.parse(read("package.json")).dependencies).toEqual({ "@haau3/sdk": "^0.4.4" });
    expect(read(".claude/skills/haau3/SKILL.md")).toBe(SKILL);
    expect(read(".agents/skills/haau3/SKILL.md")).toBe(SKILL);
    expect(JSON.parse(read(".mcp.json"))).toEqual({ mcpServers: { haau3: { type: "http", url: `${docs.url}/mcp` } } });
    expect(read(".codex/config.toml")).toBe(`[mcp_servers.haau3]\nurl = "${docs.url}/mcp"\n`);

    // No application file: only the manifest, its lockfile and the agents' files are new or changed.
    const after = filesIn(project);
    const touched = [...after.keys()].filter((file) => before.get(file) !== after.get(file)).sort();
    expect(touched).toEqual(["package-lock.json", "package.json", ...AGENT_FILES.filter((f) => after.has(f))].sort());
    expect(first.document.data.changed.map((c: { file: string }) => c.file).sort()).toEqual(touched);

    const second = await init(["--agent", "claude-code", "--agent", "codex"]);
    expect(second.code).toBe(0);
    expect(second.document.data.changed).toEqual([]);
    expect(managers.calls()).toHaveLength(1);
    expect(filesIn(project)).toEqual(after);
    expect(checksOf(second.document).sdk.message).toContain("already in package.json, so nothing was installed");
  });

  it("says what it did at a terminal, with the next steps", async () => {
    write("package.json", "{}");
    const out = await init(["--no-agent"], { tty: true });
    expect(out.code).toBe(0);
    expect(out.stdout).toContain("Set up this TypeScript or JavaScript project for haau3.");
    expect(out.stdout).toContain("Running npm install @haau3/sdk");
    expect(out.stdout).toMatch(/Changed:\n {2}updated {2}package\.json/);
    expect(out.stdout).toContain("Next:\n  node --env-file-if-exists=.env <your program>");
    const again = await init(["--no-agent"], { tty: true });
    expect(again.stdout).toContain("Changed nothing: it was already set up.");
  });
});

describe("the package manager", () => {
  const cases: { label: string; files: Record<string, string>; env?: NodeJS.ProcessEnv; expected: string[] }[] = [
    { label: "pnpm, by its lockfile", files: { "package.json": "{}", "pnpm-lock.yaml": "" }, expected: ["pnpm", "add", "@haau3/sdk"] },
    { label: "Yarn, by its lockfile", files: { "package.json": "{}", "yarn.lock": "" }, expected: ["yarn", "add", "@haau3/sdk"] },
    { label: "Bun, by its lockfile", files: { "package.json": "{}", "bun.lock": "" }, expected: ["bun", "add", "@haau3/sdk"] },
    {
      label: "the packageManager field, over a lockfile",
      files: { "package.json": JSON.stringify({ packageManager: "pnpm@10.0.0" }), "package-lock.json": "{}" },
      expected: ["pnpm", "add", "@haau3/sdk"],
    },
    { label: "the tool that ran init, with no lockfile", files: { "package.json": "{}" }, env: { npm_config_user_agent: "yarn/4.5.0 npm/? node/v24.0.0" }, expected: ["yarn", "add", "@haau3/sdk"] },
    { label: "uv, by uv.lock", files: { "pyproject.toml": '[project]\nname = "app"\ndependencies = []\n', "uv.lock": "" }, expected: ["uv", "add", "haau3"] },
    { label: "Poetry, by its tool table", files: { "pyproject.toml": '[project]\nname = "app"\ndependencies = []\n\n[tool.poetry]\npackage-mode = false\n' }, expected: ["poetry", "add", "haau3"] },
    { label: "Pipenv, by its Pipfile", files: { Pipfile: "[packages]\n" }, expected: ["pipenv", "install", "haau3"] },
    { label: "Go, by go.mod", files: { "go.mod": "module example.com/app\n\ngo 1.23\n" }, expected: ["go", "get", "github.com/haau3/haau3-go@latest"] },
  ];
  for (const c of cases) {
    it(c.label, async () => {
      for (const [name, text] of Object.entries(c.files)) write(name, text);
      const out = await init(["--no-agent"], { env: c.env });
      expect(out.code, JSON.stringify(out.document.data?.checks)).toBe(0);
      const [name, ...args] = c.expected;
      expect(managers.calls().map((call) => [call.name, ...call.args])).toEqual([[name, ...args]]);
      expect(checksOf(out.document).sdk.status).toBe("pass");
      expect((await init(["--no-agent"], { env: c.env })).document.data.changed).toEqual([]);
    });
  }

  it("uses a workspace's lockfile from the folder above, and stops at the repository's top", async () => {
    write("pnpm-lock.yaml", "");
    write("package.json", "{}");
    write("services/app/package.json", "{}");
    git("init", "-q");
    const out = await runCli(["init", "--no-agent"], { cwd: join(project, "services", "app"), env: environment() });
    const document = JSON.parse(out.stdout);
    expect(checksOf(document)["package-manager"]).toMatchObject({ details: { packageManager: "pnpm", how: "lockfile", evidence: join("..", "..", "pnpm-lock.yaml") } });
    expect(managers.calls()[0]).toMatchObject({ name: "pnpm", args: ["add", "@haau3/sdk"] });
  });

  it("installs nothing for pip, and names the line to add", async () => {
    write("requirements.txt", "requests\n");
    const out = await init(["--no-agent"]);
    expect(out.code).toBe(0);
    expect(managers.calls()).toEqual([]);
    expect(checksOf(out.document).sdk).toMatchObject({ status: "warn", next: [{ command: "pip install -r requirements.txt" }] });
    expect(checksOf(out.document).sdk.message).toContain("Add haau3>=0.4.0 to requirements.txt");
    expect(read("requirements.txt")).toBe("requests\n");
  });

  it("leaves an SDK older than its floor alone, and names the upgrade", async () => {
    write("package.json", JSON.stringify({ dependencies: { "@haau3/sdk": "^0.3.9" } }));
    write("pnpm-lock.yaml", "");
    const out = await init(["--no-agent"]);
    expect(out.code).toBe(0);
    expect(managers.calls()).toEqual([]);
    expect(checksOf(out.document).sdk).toMatchObject({ status: "warn", next: [{ command: "pnpm add @haau3/sdk@latest" }] });
  });

  it("fails, naming the command, when the manager is not on PATH or fails", async () => {
    write("Pipfile", "[packages]\n");
    const missing = await init(["--no-agent"], { path: pathOf(dirname(managers.bin)) });
    expect(missing.code).toBe(1);
    expect(missing.document.error).toMatchObject({ code: "not-set-up", next: [{ command: "pipenv install haau3" }] });
    expect(checksOf(missing.document).sdk.message).toBe("Pipenv was not found on PATH, so haau3 was not installed.");

    const failing = await init(["--no-agent"], { env: { STANDIN_MODE: "fail" } });
    expect(failing.code).toBe(1);
    expect(checksOf(failing.document).sdk).toMatchObject({ status: "fail", message: "pipenv install haau3 failed (exit code 3), so haau3 may not be installed." });
    // Its output never enters the document.
    expect(failing.stdout).not.toContain("the stand-in failed on purpose");
  });

  it("asks which one when two lockfiles disagree, and with no terminal names the flag", async () => {
    write("package.json", "{}");
    write("package-lock.json", "{}");
    write("yarn.lock", "");
    const refused = await init(["--no-agent"]);
    expect(refused.code).toBe(2);
    expect(refused.document.error.code).toBe("choice-needed");
    expect(refused.document.error.message).toContain("package-lock.json and yarn.lock");
    expect(refused.document.error.next.map((s: { command: string }) => s.command)).toEqual([
      "npx haau3 init --package-manager npm --no-agent",
      "npx haau3 init --package-manager yarn --no-agent",
    ]);
    expect(managers.calls()).toEqual([]);

    const asked: string[] = [];
    const ask = async (question: string, choices: string[]) => {
      asked.push(question, ...choices);
      return [1];
    };
    const person = await init(["--no-agent"], { tty: true, io: { stdin: { isTTY: true }, ask } });
    expect(person.code).toBe(0);
    expect(asked).toContain("Yarn");
    expect(managers.calls()[0]).toMatchObject({ name: "yarn" });

    write("package.json", "{}");
    const flagged = await init(["--no-agent", "--package-manager", "npm"]);
    expect(flagged.code).toBe(0);
    expect(managers.calls().at(-1)).toMatchObject({ name: "npm" });
  });
});

describe("choices it cannot make", () => {
  it("refuses a folder with no project, naming how to start one", async () => {
    const out = await init(["--no-agent"]);
    expect(out.code).toBe(1);
    expect(out.document.error.code).toBe("no-project");
    expect(out.document.error.next.map((s: { command: string }) => s.command)).toEqual(["npm init -y", "uv init --bare", "go mod init example.com/app"]);
    expect(filesIn(project).size).toBe(0);
  });

  it("asks which project when the folder holds two, and with no terminal names --language", async () => {
    write("package.json", "{}");
    write("go.mod", "module example.com/app\n");
    const refused = await init(["--no-agent"]);
    expect(refused.code).toBe(2);
    expect(refused.document.error).toMatchObject({ code: "choice-needed" });
    expect(refused.document.error.next.map((s: { command: string }) => s.command)).toEqual(["npx haau3 init --language node --no-agent", "npx haau3 init --language go --no-agent"]);
    expect(managers.calls()).toEqual([]);
    const chosen = await init(["--no-agent", "--language", "go"]);
    expect(chosen.code).toBe(0);
    expect(managers.calls()[0]).toMatchObject({ name: "go" });
    const wrong = await init(["--no-agent", "--language", "python"]);
    expect(wrong.document.error).toMatchObject({ code: "no-project", next: [{ command: "uv init --bare" }] });
  });

  it("finds no agent, then refuses before changing anything, naming --agent and --no-agent", async () => {
    write("package.json", "{}");
    const out = await init();
    expect(out.code).toBe(2);
    expect(out.document.error.code).toBe("choice-needed");
    expect(out.document.error.next.map((s: { command: string }) => s.command)).toEqual(["npx haau3 init --agent claude-code", "npx haau3 init --no-agent"]);
    expect(managers.calls()).toEqual([]);
    expect([...filesIn(project).keys()]).toEqual(["package.json"]);
  });

  it("asks a person at a terminal which agents, and sets up those", async () => {
    write("package.json", "{}");
    const ask = async (_question: string, choices: string[], multiple: boolean) => {
      expect(multiple).toBe(true);
      expect(choices).toEqual(["Claude Code", "Cursor", "Codex", "VS Code", "Gemini CLI", "None: only the SDK and the env file"]);
      return [1, 3];
    };
    const out = await init([], { tty: true, io: { stdin: { isTTY: true }, ask } });
    expect(out.code).toBe(0);
    expect(JSON.parse(read(".cursor/mcp.json"))).toEqual({ mcpServers: { haau3: { url: `${docs.url}/mcp` } } });
    expect(JSON.parse(read(".vscode/mcp.json"))).toEqual({ servers: { haau3: { type: "http", url: `${docs.url}/mcp` } } });
    expect(existsSync(join(project, ".agents/skills/haau3/SKILL.md"))).toBe(true);
    expect(existsSync(join(project, ".claude"))).toBe(false);
  });

  it("never asks when an agent runs it, even in a terminal", async () => {
    write("package.json", "{}");
    let asked = false;
    const ask = async () => {
      asked = true;
      return [0];
    };
    const out = await runCli(["init"], { cwd: project, tty: true, env: environment({ CODEX_THREAD_ID: "t" }), io: { stdin: { isTTY: true }, ask } });
    expect(asked).toBe(false);
    // Codex runs it, so Codex is the agent found.
    expect(JSON.parse(out.stdout).data.agents).toEqual(["codex"]);
  });

  it("refuses flags it cannot use, without repeating a value that could be a key", async () => {
    write("package.json", "{}");
    const cases: [string[], string][] = [
      [["--agent", "emacs"], "invalid-agent"],
      [["--agent", "claude-code", "--no-agent"], "conflicting-flags"],
      [["--language", "rust"], "invalid-language"],
      [["--package-manager", "cargo"], "invalid-package-manager"],
      [["--package-manager", "uv", "--no-agent"], "invalid-package-manager"],
      [["--file", "notes.txt"], "invalid-file"],
    ];
    for (const [args, code] of cases) {
      const out = await init(args);
      expect(out.code, args.join(" ")).toBe(2);
      expect(out.document.error.code).toBe(code);
    }
    const keyLike = ["haau3", "sk", "live", "Q".repeat(30)].join("_");
    const out = await init(["--agent", keyLike]);
    expect(out.stdout).not.toContain(keyLike);
    expect(managers.calls()).toEqual([]);
  });

  it("refuses the home folder", async () => {
    const out = await runCli(["init", "--no-agent"], { cwd: home, env: environment() });
    expect(JSON.parse(out.stdout).error.code).toBe("not-a-project");
    expect(out.code).toBe(2);
  });
});

describe("the coding agents' files", () => {
  beforeEach(() => write("package.json", JSON.stringify({ dependencies: { "@haau3/sdk": "^0.4.4" } })));

  it("finds the agents a project uses from its files", async () => {
    write(".cursor/rules.md", "x");
    write("GEMINI.md", "x");
    const out = await init();
    expect(out.document.data.agents).toEqual(["cursor", "gemini-cli"]);
    expect(out.document.data.agentsBy).toEqual({ cursor: ".cursor", "gemini-cli": "GEMINI.md" });
    expect(JSON.parse(read(".gemini/settings.json"))).toEqual({ mcpServers: { haau3: { httpUrl: `${docs.url}/mcp` } } });
    expect(checksOf(out.document).mcp.message).toContain("Gemini CLI reads it once you trust this folder.");
  });

  it("adds the entry beside the person's own, keeping their indent and every other value", async () => {
    const own = { mcpServers: { mine: { command: "run-it", args: ["--port", "8080"], env: { N: 1.5 } } }, other: [1, 2] };
    write(".mcp.json", `${JSON.stringify(own, null, 4)}\n`);
    const out = await init(["--agent", "claude-code"]);
    expect(out.code).toBe(0);
    const text = read(".mcp.json");
    expect(text).toContain('\n    "mcpServers": {');
    expect(JSON.parse(text)).toEqual({ ...own, mcpServers: { ...own.mcpServers, haau3: { type: "http", url: `${docs.url}/mcp` } } });
    expect(text.endsWith("}\n")).toBe(true);
  });

  it("leaves a file it cannot read safely, and an entry for another server, saying what to add", async () => {
    const commented = '{\n  // mine\n  "servers": {}\n}\n';
    write(".vscode/mcp.json", commented);
    const theirs = `${JSON.stringify({ mcpServers: { haau3: { type: "http", url: "https://example.com/mcp" } } })}\n`;
    write(".mcp.json", theirs);
    // A number past what JavaScript holds exactly: written back, it would read differently.
    write(".cursor/mcp.json", '{"mcpServers":{"mine":{"timeout":12345678901234567890}}}\n');
    const out = await init(["--agent", "vscode", "--agent", "claude-code", "--agent", "cursor"]);
    expect(out.code).toBe(0);
    expect(read(".vscode/mcp.json")).toBe(commented);
    expect(read(".mcp.json")).toBe(theirs);
    const mcp = checksOf(out.document).mcp;
    expect(mcp.status).toBe("warn");
    expect(mcp.message).toContain(".vscode/mcp.json is not plain JSON (it may hold comments)");
    expect(mcp.message).toContain(`To add it yourself: "haau3": {"type":"http","url":"${docs.url}/mcp"} in "servers"`);
    expect(mcp.message).toContain(".mcp.json already has an entry named haau3 for another server");
    expect(mcp.message).toContain(".cursor/mcp.json holds a number haau3 could not write back exactly");
    expect(out.document.data.changed.map((c: { file: string }) => c.file)).not.toContain(".mcp.json");
  });

  it("appends to Codex's config, and leaves one that spells mcp_servers another way", async () => {
    write(".codex/config.toml", 'model = "x"\n\n[mcp_servers.other]\ncommand = "run"\n');
    await init(["--agent", "codex"]);
    expect(read(".codex/config.toml")).toBe(`model = "x"\n\n[mcp_servers.other]\ncommand = "run"\n\n[mcp_servers.haau3]\nurl = "${docs.url}/mcp"\n`);
    const again = await init(["--agent", "codex"]);
    expect(again.document.data.changed).toEqual([]);

    const inline = 'mcp_servers = { haau3 = { url = "https://example.com" } }\n';
    write(".codex/config.toml", inline);
    const out = await init(["--agent", "codex"]);
    expect(read(".codex/config.toml")).toBe(inline);
    expect(checksOf(out.document).mcp.status).toBe("warn");
  });

  it("updates a skill that differs from the docs', and never writes through a link", async () => {
    write(".claude/skills/haau3/SKILL.md", "an older skill\n");
    const out = await init(["--agent", "claude-code"]);
    expect(read(".claude/skills/haau3/SKILL.md")).toBe(SKILL);
    expect(out.document.data.changed).toContainEqual({ file: ".claude/skills/haau3/SKILL.md", action: "updated" });

    const elsewhere = mkdtempSync(join(tmpdir(), "cli-init-elsewhere-"));
    try {
      rmSync(join(project, ".agents"), { recursive: true, force: true });
      try {
        symlinkSync(elsewhere, join(project, ".agents"), "dir");
      } catch {
        return; // This system makes no links for this user; the check above still ran.
      }
      const linked = await init(["--agent", "codex"]);
      expect(checksOf(linked.document).skill).toMatchObject({ status: "warn" });
      expect(checksOf(linked.document).skill.message).toContain(".agents is a link, which haau3 does not write through");
      expect(filesIn(elsewhere).size).toBe(0);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("checks the skill before writing it: the docs' own host, its size, its name and its text", async () => {
    const cases: [typeof docs.mode, string][] = [
      ["redirect-away", "to another host, which haau3 does not follow"],
      ["missing", "answered HTTP 404"],
      ["too-big", "is larger than 256 KB"],
      ["not-haau3", "is not the haau3 skill"],
      ["not-text", "is not UTF-8 text"],
    ];
    for (const [mode, says] of cases) {
      docs.mode = mode;
      const out = await init(["--agent", "claude-code"]);
      expect(out.code, mode).toBe(1);
      expect(out.document.error.code).toBe("not-set-up");
      expect(checksOf(out.document).skill.message, mode).toContain(says);
      expect(existsSync(join(project, ".claude", "skills")), mode).toBe(false);
    }
    docs.mode = "redirect-same";
    const moved = await init(["--agent", "claude-code"]);
    expect(moved.code).toBe(0);
    expect(read(".claude/skills/haau3/SKILL.md")).toBe(SKILL);
    // The docs get no key and no session.
    expect(docs.requests.every((r) => r.headers.authorization === undefined && r.headers.cookie === undefined)).toBe(true);
  });
});

describe("the env file", () => {
  beforeEach(() => write("package.json", JSON.stringify({ dependencies: { "@haau3/sdk": "^0.4.4" } })));

  it("fails with the line to add when git would not ignore it, after the other steps ran", async () => {
    git("init", "-q");
    const out = await init(["--agent", "claude-code"]);
    expect(out.code).toBe(1);
    expect(out.document.error).toMatchObject({ code: "env-file-not-ignored", gitignore: { file: ".gitignore", line: ".env" } });
    expect(out.document.data.checks.map((c: { name: string }) => c.name)).toEqual(["language", "package-manager", "sdk", "skill", "mcp", "env-file-ignored"]);
    expect(existsSync(join(project, ".mcp.json"))).toBe(true);
    expect(existsSync(join(project, ".gitignore"))).toBe(false);

    write(".gitignore", ".env\n");
    const fixed = await init(["--agent", "claude-code"]);
    expect(fixed.code).toBe(0);
    expect(checksOf(fixed.document)["env-file-ignored"]).toMatchObject({ status: "pass" });
  });

  it("says a tracked file must stop being tracked", async () => {
    git("init", "-q");
    write(".env", "PORT=1\n");
    git("add", ".env");
    write(".gitignore", ".env\n");
    const out = await init(["--no-agent"]);
    expect(out.document.error).toMatchObject({ code: "env-file-tracked", gitignore: { line: ".env" } });
    expect(out.document.error.next[0].command).toBe("git rm --cached -- .env");
  });

  it("names .env.local for Next.js, and how each project loads its file", async () => {
    write("package.json", JSON.stringify({ dependencies: { "@haau3/sdk": "^0.4.4", next: "16.0.0" } }));
    const next = await init(["--no-agent"]);
    expect(next.document.data.envFile).toBe(".env.local");
    expect(next.document.data.next.map((s: { command: string }) => s.command)).toEqual(["npx haau3 test", "npx haau3 login", "npx haau3 keys create", "npx haau3 doctor"]);
    expect(checksOf(next.document)["env-file-ignored"].message).toContain("Next.js loads .env.local itself.");

    rmSync(join(project, "package.json"));
    write("pyproject.toml", '[project]\nname = "app"\ndependencies = ["haau3>=0.4.4"]\n');
    write("uv.lock", "");
    const uv = await init(["--no-agent"]);
    expect(uv.document.data.next[0].command).toBe("uv run --env-file .env <your program>");
  });

  it("names only doctor after the loader once a key is found", async () => {
    const key = ["haau3", "sk", "live", "K".repeat(40)].join("_");
    const out = await init(["--no-agent"], { env: { HAAU3_API_KEY: key } });
    expect(out.document.data.next.map((s: { command: string }) => s.command)).toEqual(["node --env-file-if-exists=.env <your program>", "npx haau3 doctor"]);
    expect(out.stdout).not.toContain(key);
  });
});
