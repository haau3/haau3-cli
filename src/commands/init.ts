// `haau3 init`: sets a project up to use haau3, and writes no application code. It reads what the
// project is, then asks, or refuses with no terminal, for any choice its files do not settle, before it
// changes anything. Then: haau3's SDK through the project's own package manager, which edits the
// manifest itself (never by hand); the haau3 skill from the docs, and the docs' MCP server, for each
// coding agent the project uses; and git's answer on the env file a key will go to, which it never
// fixes itself. Run again, it changes nothing: `changed` lists every file it wrote, and is empty.
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, parse, relative, resolve } from "node:path";
import { AGENT_NAMES, AGENTS, detectAgents, isAgent, type Agent } from "../agents/detect.js";
import type { FileOutcome } from "../agents/files.js";
import { addMcpEntries, entryText, MCP_TARGETS } from "../agents/mcp.js";
import { fetchSkill, SKILL_FILES, writeSkill } from "../agents/skill.js";
import { sandboxNamed } from "../calls.js";
import { chooseFile, fileFlagError, homeOf, printablePath, readsEnvLocal, shownPath } from "../envfile.js";
import { DEFAULT_DOCS_URL, DOCS_URL_VARIABLE, resolveDocs } from "../environment.js";
import { gitAnswer, sameFolder } from "../git.js";
import { EXIT, failure, success, type CliError, type NextStep } from "../output.js";
import { ADD, ALL_MANAGERS, detectManager, MANAGERS, managerFor, MANIFEST_FILES, UPGRADE, type Manager, type ManagerFound } from "../packages.js";
import { readProject, SDK_FLOORS, type Language, type Project } from "../project.js";
import { findProgram, runProgram } from "../run.js";
import { findSettings } from "../settings.js";
import { arg, doctorStep, fileFlag, KEYS_CREATE_STEP, keysCreateStep, LOGIN_STEP, misused, type Context, type Result } from "./context.js";
import { gitignoreLine } from "./keys.js";

const COMMAND = "init";

/** Every check, in the order each run lists them. */
export const INIT_CHECKS = ["language", "package-manager", "sdk", "skill", "mcp", "env-file-ignored"] as const;
export type InitCheckName = (typeof INIT_CHECKS)[number];
export type InitStatus = "pass" | "warn" | "fail" | "skip";

/** One line of the report, in doctor's shape. */
export interface InitCheck {
  name: InitCheckName;
  status: InitStatus;
  message: string;
  next: NextStep[];
  details: Record<string, unknown>;
}

/** A file init wrote, itself or through the package manager. */
export interface Changed {
  file: string;
  action: "created" | "updated";
}

export interface InitOptions {
  language: string | undefined;
  packageManager: string | undefined;
  agents: string[];
  noAgent: boolean;
  /** The env file to check in place of .env.local and .env, as given with --file. */
  file: string | undefined;
}

/** How long a package manager may take to add the SDK. */
export const INSTALL_TIMEOUT_MS = 5 * 60_000;

/** A lockfile bigger than this is not hashed to see whether it changed. */
const MAX_HASHED_BYTES = 64 * 1024 * 1024;

const LANGUAGES: readonly Language[] = ["node", "python", "go"];
const LANGUAGE_NAME: Readonly<Record<Language, string>> = { node: "TypeScript or JavaScript", python: "Python", go: "Go" };
const MANIFESTS: Readonly<Record<Language, string>> = { node: "package.json", python: "pyproject.toml, requirements.txt or Pipfile", go: "go.mod" };
const MANAGER_NAME: Readonly<Record<Manager, string>> = { npm: "npm", pnpm: "pnpm", yarn: "Yarn", bun: "Bun", uv: "uv", poetry: "Poetry", pipenv: "Pipenv", pip: "pip", go: "Go" };

/** A word safe to repeat back: it cannot be a key, a path or anything else typed by mistake. */
const SAFE_WORD = /^[a-z][a-z0-9-]{0,40}$/;

const START: Readonly<Record<Language, NextStep>> = {
  node: { command: "npm init -y", description: "Start a TypeScript or JavaScript project here: a package.json. Then run npx haau3 init again." },
  python: {
    command: "uv init --bare --python 3.10",
    description: "Start a Python project here: a pyproject.toml and nothing else, for Python 3.10 or newer, which the SDK needs. Then run npx haau3 init again.",
  },
  go: { command: "go mod init example.com/app", description: "Start a Go module here, named as yours will be. Then run npx haau3 init again." },
};

const TEST_STEP: NextStep = { command: "npx haau3 test", description: "Call each service once in the Sandbox, with no key and no account." };

const check = (name: InitCheckName, status: InitStatus, message: string, next: NextStep[] = [], details: Record<string, unknown> = {}): InitCheck => ({
  name,
  status,
  message,
  next,
  details,
});

/** The same command again, with the flags it was given and any changed. */
function rerun(options: InitOptions, change: Partial<InitOptions> = {}): string {
  const o = { ...options, ...change };
  const parts = ["npx haau3 init"];
  if (o.language !== undefined) parts.push(`--language ${o.language}`);
  if (o.packageManager !== undefined) parts.push(`--package-manager ${o.packageManager}`);
  for (const agent of o.agents) parts.push(`--agent ${agent}`);
  if (o.noAgent) parts.push("--no-agent");
  if (o.file !== undefined) parts.push(fileFlag(o.file));
  return parts.join(" ");
}

function list(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** Asks a person at a terminal to pick; null where nobody can, or nobody did. */
async function choose(ctx: Context, question: string, choices: string[], multiple: boolean): Promise<number[] | null> {
  if (!ctx.interactive || !ctx.ask) return null;
  return ctx.ask(question, choices, multiple);
}

function choiceNeeded(message: string, next: NextStep[]): Result {
  return misused(COMMAND, { code: "choice-needed", message, next });
}

// --- the package manager's install ---------------------------------------------------------------

/** The manifests and lockfiles in the project's folder and the manager's, by content. */
function snapshot(folders: string[]): Map<string, string | null> {
  const seen = new Map<string, string | null>();
  for (const folder of folders) {
    for (const name of MANIFEST_FILES) {
      const path = join(folder, name);
      if (seen.has(path)) continue;
      try {
        const stats = statSync(path);
        if (!stats.isFile() || stats.size > MAX_HASHED_BYTES) {
          seen.set(path, stats.isFile() ? `size:${stats.size}:${stats.mtimeMs}` : null);
          continue;
        }
        seen.set(path, createHash("sha256").update(readFileSync(path)).digest("hex"));
      } catch {
        seen.set(path, null);
      }
    }
  }
  return seen;
}

function changesBetween(before: Map<string, string | null>, after: Map<string, string | null>, cwd: string): Changed[] {
  const changed: Changed[] = [];
  for (const [path, now] of after) {
    const was = before.get(path) ?? null;
    if (now === null || now === was) continue;
    changed.push({ file: relative(cwd, path) || basename(path), action: was === null ? "created" : "updated" });
  }
  return changed;
}

async function sdkStep(
  ctx: Context,
  project: Project,
  language: Language,
  found: ManagerFound,
  folder: string,
  platform: NodeJS.Platform,
  options: InitOptions,
): Promise<{ check: InitCheck; changed: Changed[] }> {
  const { package: name, floor } = SDK_FLOORS[language];
  const manager = found.manager;
  const declared = project.sdks.find((sdk) => sdk.language === language);
  if (declared) {
    const version = declared.installed ?? declared.declared;
    const details = { package: name, manifest: declared.manifest, declared: declared.declared, installed: declared.installed, installedBy: null };
    if (declared.verdict === "below") {
      return {
        check: check(
          "sdk",
          "warn",
          `${name} ${version ?? ""} in ${declared.manifest} is older than ${floor}, the first version in which the key's mode picks the host. haau3 left it as it is: a newer one can change what your code calls.`.replace(/ {2,}/g, " "),
          [{ command: UPGRADE[manager], description: `Upgrade ${name} when your code is ready for it, and require ${floor} or newer in ${declared.manifest}.` }],
          details,
        ),
        changed: [],
      };
    }
    return { check: check("sdk", "pass", `${name}${version ? ` ${version}` : ""} is already in ${declared.manifest}, so nothing was installed.`, [], details), changed: [] };
  }

  const args = ADD[manager];
  if (args === null) {
    const requirements = statSafe(join(folder, "requirements.txt"));
    const pip: NextStep = requirements
      ? { command: "pip install -r requirements.txt", description: `Install the requirements once haau3>=${floor} is a line in requirements.txt.` }
      : { command: `pip install "haau3>=${floor}"`, description: "Install the SDK in the project's virtual environment, and list it in the project's dependencies." };
    // A pyproject.toml that names no tool, as `uv init` makes one, may still be uv's or Poetry's.
    const tools: NextStep[] =
      found.how === "default" && statSafe(join(folder, "pyproject.toml"))
        ? (["uv", "poetry"] as const).map((tool) => ({
            command: rerun(options, { packageManager: tool }),
            description: `Or, if this project uses ${MANAGER_NAME[tool]}, run init naming it: ${MANAGER_NAME[tool]} adds haau3 and records it.`,
          }))
        : [];
    return {
      check: check(
        "sdk",
        "warn",
        `pip records nothing in a manifest, so haau3 installed nothing. Add haau3>=${floor} to ${requirements ? "requirements.txt" : "the project's dependencies"}, then install it in the project's virtual environment.`,
        [pip, ...tools],
        { package: name, installedBy: null },
      ),
      changed: [],
    };
  }

  const commandLine = [manager, ...args].join(" ");
  const program = findProgram(manager, ctx.env, folder, platform, [".exe", ".cmd"]);
  if (!program) {
    return {
      check: check("sdk", "fail", `${MANAGER_NAME[manager]} was not found on PATH, so ${name} was not installed.`, [{ command: commandLine, description: `Install ${MANAGER_NAME[manager]}, then run this in the project's folder.` }], {
        package: name,
        installedBy: null,
      }),
      changed: [],
    };
  }
  const folders = [folder, found.folder];
  const before = snapshot(folders);
  ctx.say(`Running ${commandLine}\n`);
  const ran = await runProgram(program, args, {
    cwd: folder,
    env: ctx.env,
    timeoutMs: INSTALL_TIMEOUT_MS,
    platform,
    output: ctx.format === "text" ? (text) => ctx.say(text) : undefined,
  });
  const changed = changesBetween(before, snapshot(folders), folder);
  const details = { package: name, installedBy: commandLine };
  const again: NextStep = { command: commandLine, description: "Run it yourself in the project's folder to see what went wrong." };
  if (ran.kind === "timed-out") {
    return { check: check("sdk", "fail", `${commandLine} did not finish within ${INSTALL_TIMEOUT_MS / 60_000} minutes, so haau3 stopped it.`, [again], details), changed };
  }
  if (ran.kind === "not-started") return { check: check("sdk", "fail", `${commandLine} could not be started.`, [again], details), changed };
  if (ran.code !== 0) return { check: check("sdk", "fail", `${commandLine} failed (exit code ${ran.code}), so ${name} may not be installed.`, [again], details), changed };
  const now = readProject(folder).sdks.find((sdk) => sdk.language === language);
  if (!now) return { check: check("sdk", "warn", `${commandLine} finished, yet ${MANIFESTS[language]} does not name ${name}.`, [again], details), changed };
  return { check: check("sdk", "pass", `Added ${name}${now.declared ? ` ${now.declared}` : ""} with ${commandLine}.`, [], { ...details, manifest: now.manifest, declared: now.declared }), changed };
}

/** The manifest that makes the folder a project of this language, as readProject finds them. */
function manifestOf(folder: string, language: Language): string {
  if (language === "node") return "package.json";
  if (language === "go") return "go.mod";
  return ["pyproject.toml", "Pipfile", "requirements.txt", "setup.py", "setup.cfg"].find((name) => statSafe(join(folder, name))) ?? "requirements file";
}

function statSafe(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

// --- the coding agents ---------------------------------------------------------------------------

function changedFiles(outcomes: FileOutcome[]): Changed[] {
  return outcomes.flatMap((o) => (o.result === "created" || o.result === "updated" ? [{ file: o.file, action: o.result }] : []));
}

function describe(outcomes: FileOutcome[], what: string): string {
  const sentences: string[] = [];
  const of = (result: FileOutcome["result"]) => outcomes.filter((o) => o.result === result).map((o) => o.file);
  if (of("created").length) sentences.push(`Added ${what} in ${list(of("created"))}.`);
  if (of("updated").length) sentences.push(`Updated ${what} in ${list(of("updated"))}.`);
  if (of("unchanged").length) sentences.push(`${list(of("unchanged"))} already ${of("unchanged").length === 1 ? "has" : "have"} it.`);
  return sentences.join(" ");
}

async function skillStep(ctx: Context, agents: Agent[], docsURL: string, folder: string, options: InitOptions): Promise<{ check: InitCheck; changed: Changed[] }> {
  if (agents.length === 0) return { check: check("skill", "skip", "No coding agent to set up (--no-agent).", [], { files: [] }), changed: [] };
  const source = `${docsURL}/skill.md`;
  const fetched = await fetchSkill(docsURL, ctx.fetch ?? fetch);
  if (!fetched.ok) {
    return {
      check: check("skill", "fail", `The haau3 skill was not added: ${fetched.why}.`, [{ command: rerun(options), description: "Run init again once the docs answer." }], { source, files: [] }),
      changed: [],
    };
  }
  const outcomes = writeSkill(folder, agents.map((agent) => SKILL_FILES[agent]), fetched.bytes);
  const left = outcomes.flatMap((o) => (o.result === "left" ? [o] : []));
  const details = { source, files: outcomes };
  const done = [overridden(docsURL), describe(outcomes, "the haau3 skill")].filter(Boolean).join(" ");
  // A link where the skill goes could be anyone's file: the agent would read it as haau3's skill.
  const linked = left.filter((o) => o.link);
  if (linked.length) {
    const why = linked.map((o) => o.why).join("; ");
    return {
      check: check("skill", "fail", `${done ? `${done} ` : ""}Not added: ${why}. Remove the link, then run init again.`, [{ command: rerun(options), description: "Run init again once the link is gone." }], details),
      changed: changedFiles(outcomes),
    };
  }
  if (left.length) {
    return { check: check("skill", "warn", `${done ? `${done} ` : ""}Left as it was: ${left.map((o) => o.why).join("; ")}.`, [], details), changed: changedFiles(outcomes) };
  }
  return { check: check("skill", overridden(docsURL) ? "warn" : "pass", done, [], details), changed: changedFiles(outcomes) };
}

/** Said first in the skill's and the MCP server's lines when the docs are not docs.haau3.com. */
function overridden(docsURL: string): string {
  return docsURL === DEFAULT_DOCS_URL ? "" : `From ${new URL(docsURL).host}, as ${DOCS_URL_VARIABLE} asks, in place of ${new URL(DEFAULT_DOCS_URL).host}.`;
}

function mcpStep(agents: Agent[], docsURL: string, folder: string): { check: InitCheck; changed: Changed[] } {
  if (agents.length === 0) return { check: check("mcp", "skip", "No coding agent to set up (--no-agent).", [], { files: [] }), changed: [] };
  const url = `${docsURL}/mcp`;
  const outcomes = addMcpEntries(folder, agents, url);
  const details = { url, files: outcomes };
  const done = describe(outcomes, `the docs' MCP server, ${url},`);
  const notes: string[] = [];
  // What each agent does with a project's MCP file, said only where init just wrote one.
  const written = (agent: Agent) => outcomes.some((o) => o.file === MCP_TARGETS[agent].file && (o.result === "created" || o.result === "updated"));
  if (agents.includes("claude-code") && written("claude-code")) notes.push("Claude Code asks you to approve it the first time it starts here.");
  const trusted = (["codex", "gemini-cli"] as const).filter((agent) => agents.includes(agent) && written(agent)).map((agent) => AGENT_NAMES[agent]);
  if (trusted.length) notes.push(`${list(trusted)} ${trusted.length === 1 ? "reads" : "read"} it once you trust this folder.`);
  const left = agents.flatMap((agent) => {
    const outcome = outcomes.find((o) => o.file === MCP_TARGETS[agent].file);
    return outcome?.result === "left" ? [`${outcome.why}. To add it yourself: ${entryText(agent, url)}`] : [];
  });
  const message = [overridden(docsURL), done, ...notes, ...left.map((l) => `${l}.`)].filter(Boolean).join(" ");
  return { check: check("mcp", left.length || overridden(docsURL) ? "warn" : "pass", message, [], details), changed: changedFiles(outcomes) };
}

// --- the env file --------------------------------------------------------------------------------

interface EnvStep {
  check: InitCheck;
  shown: string;
  gitignore: { file: string; line: string } | null;
  tracked: boolean;
}

async function envStep(ctx: Context, folder: string, options: InitOptions, platform: NodeJS.Platform): Promise<EnvStep> {
  const chosen = chooseFile({ cwd: folder, file: options.file, env: ctx.env, platform });
  if (!chosen.ok) return { check: check("env-file-ignored", "warn", chosen.error.message, [], { file: null }), shown: ".env", gitignore: null, tracked: false };
  const target = chosen.chosen;
  const shown = target.shown;
  const holds = target.reason === "holds-key";
  const where = holds ? `${shown}, which holds the key,` : `${shown}, where keys create will write the key,`;
  const git = await gitAnswer(target.path, ctx.env, folder);
  const details: Record<string, unknown> = { file: shown, git: git.kind };
  const line = gitignoreLine(basename(target.path));
  if (git.kind === "ignored") return { check: check("env-file-ignored", "pass", `git ignores ${where.replace(/,$/, "")}.`, [], details), shown, gitignore: null, tracked: false };
  if (git.kind === "no-repository") {
    const message = `${shown} is not in a git repository, so nothing could commit it. If you make one, add ${line} to its .gitignore first.`;
    return { check: check("env-file-ignored", "skip", message, [], details), shown, gitignore: null, tracked: false };
  }
  if (git.kind === "git-unavailable") {
    return { check: check("env-file-ignored", "warn", `${shown} is in a git repository and git could not be found on PATH, so haau3 could not check that git ignores it.`, [], details), shown, gitignore: null, tracked: false };
  }
  if (git.kind === "git-failed") {
    return { check: check("env-file-ignored", "warn", `git could not say whether it ignores ${shown}. Run git status in that folder to see why.`, [], details), shown, gitignore: null, tracked: false };
  }
  const besideFile = shownPath(join(dirname(target.path), ".gitignore"), folder);
  const gitignore = printablePath(besideFile) ? besideFile : join(dirname(shown), ".gitignore");
  details.gitignore = { file: gitignore, line };
  if (git.tracked) {
    const name = basename(shown);
    const dir = dirname(shown);
    const untrack = dir === "." ? `git rm --cached -- ${arg(name)}` : `git -C ${arg(dir)} rm --cached -- ${arg(name)}`;
    return {
      check: check(
        "env-file-ignored",
        "fail",
        `git tracks ${shown}, so a key in it is committed with it. Stop tracking it, add this line to ${gitignore}, and commit:\n  ${line}\nhaau3 never edits a .gitignore itself.`,
        [{ command: untrack, description: `Stop tracking ${shown}, keeping the file. Then add ${line} to ${gitignore} and commit.` }],
        details,
      ),
      shown,
      gitignore: { file: gitignore, line },
      tracked: true,
    };
  }
  return {
    check: check(
      "env-file-ignored",
      "fail",
      `git does not ignore ${where} so the key could be committed. Add this line to ${gitignore}:\n  ${line}\nhaau3 never edits a .gitignore itself.`,
      [{ command: rerun(options), description: `Check again after adding ${line} to ${gitignore}.` }],
      details,
    ),
    shown,
    gitignore: { file: gitignore, line },
    tracked: false,
  };
}

/** A file as `.` takes it in a POSIX shell: with a slash, so the shell does not look for it on PATH. */
function sourced(file: string): string {
  return isAbsolute(file) || file.startsWith("./") || file.startsWith("../") ? arg(file) : arg(`./${file}`);
}

/**
 * How this project's program loads the env file, or null when its own runner does (Next.js, Bun,
 * Pipenv) and there is nothing to run. Named, never written: the start command is the person's.
 */
function loader(language: Language, manager: Manager, file: string, nextjs: boolean): { step: NextStep | null; note: string } {
  const isDefault = file === ".env" || file === ".env.local";
  const shell: NextStep = {
    command: `set -a; . ${sourced(file)}; set +a`,
    description: `Load ${file} into this shell before you run your program, in a POSIX shell, for a file of plain NAME=value lines.`,
  };
  if (language === "node") {
    if (nextjs && isDefault) return { step: null, note: `Next.js loads ${file} itself.` };
    if (manager === "bun" && isDefault) return { step: null, note: `Bun loads ${file} itself when it runs your program.` };
    return {
      step: {
        command: `node --env-file-if-exists=${arg(file)} <your program>`,
        description: `Start your program this way so it reads ${file}: Node reads no env file by itself. It needs Node 22.9 or newer; process.loadEnvFile() at the program's start does the same.`,
      },
      note: `Node reads no env file by itself.`,
    };
  }
  if (language === "python") {
    if (manager === "uv") {
      return {
        step: { command: `uv run --env-file ${arg(file)} <your program>`, description: `Run your program this way so it reads ${file}: Python reads no env file by itself.` },
        note: "Python reads no env file by itself.",
      };
    }
    if (manager === "pipenv" && file === ".env") return { step: null, note: "pipenv run loads .env itself." };
    return { step: { ...shell, description: `${shell.description} Or call load_dotenv() from python-dotenv when your program starts.` }, note: "Python reads no env file by itself." };
  }
  return { step: { ...shell, description: `${shell.description} Go reads no env file by itself.` }, note: "Go reads no env file by itself." };
}

// --- the report ----------------------------------------------------------------------------------

/** Each command once, in order. */
function unique(steps: NextStep[]): NextStep[] {
  const seen = new Set<string>();
  return steps.filter((step) => (seen.has(step.command) ? false : (seen.add(step.command), true)));
}

const STATUS_WIDTH = 4;
const NAME_WIDTH = Math.max(...INIT_CHECKS.map((name) => name.length));

function lineOf(c: InitCheck): string {
  const indent = " ".repeat(2 + STATUS_WIDTH + 2 + NAME_WIDTH + 2);
  const [first, ...rest] = c.message.split("\n");
  return [`  ${c.status.padEnd(STATUS_WIDTH)}  ${c.name.padEnd(NAME_WIDTH)}  ${first}`, ...rest.map((line) => `${indent}${line}`)].join("\n");
}

export async function init(ctx: Context, options: InitOptions): Promise<Result> {
  const platform = process.platform;

  // Every flag is checked before anything is read, asked or changed.
  if (options.file !== undefined) {
    const refused = fileFlagError(options.file, { command: "npx haau3 init", description: "Check the project's own env file instead." });
    if (refused) return misused(COMMAND, refused);
  }
  if (options.language !== undefined && !(LANGUAGES as readonly string[]).includes(options.language)) {
    const named = SAFE_WORD.test(options.language) ? `, not ${options.language}` : "";
    return misused(COMMAND, { code: "invalid-language", message: `--language takes node, python or go${named}.`, next: [{ command: "npx haau3 --help", description: "See what haau3 can do." }] });
  }
  for (const agent of options.agents) {
    if (!isAgent(agent)) {
      const named = SAFE_WORD.test(agent) ? `, not ${agent}` : "";
      return misused(COMMAND, { code: "invalid-agent", message: `--agent takes ${list([...AGENTS])}${named}.`, next: [{ command: "npx haau3 --help", description: "See what haau3 can do." }] });
    }
  }
  if (options.noAgent && options.agents.length > 0) {
    return misused(COMMAND, { code: "conflicting-flags", message: "--agent and --no-agent ask for opposite things. Give one of them.", next: [] });
  }
  if (options.packageManager !== undefined && !(ALL_MANAGERS as readonly string[]).includes(options.packageManager)) {
    const named = SAFE_WORD.test(options.packageManager) ? `, not ${options.packageManager}` : "";
    return misused(COMMAND, { code: "invalid-package-manager", message: `--package-manager takes ${list([...ALL_MANAGERS])}${named}.`, next: [] });
  }
  const docs = resolveDocs(ctx.env);
  if (!docs.ok) return misused(COMMAND, docs.error);

  const folder = resolve(ctx.cwd);
  const home = homeOf(ctx.env, platform);
  if (sameFolder(folder, home, platform) || parse(folder).root === folder) {
    return misused(COMMAND, {
      code: "not-a-project",
      message: "haau3 init sets up the project in the folder it runs in, and this is your home folder or a drive's root. Run it in your project's folder.",
      next: [],
    });
  }

  // The language: the one the folder's manifests name, or the one chosen.
  const project = readProject(folder);
  if (project.languages.length === 0) {
    return {
      document: failure(COMMAND, {
        code: "no-project",
        message: "There is no package.json, pyproject.toml, requirements.txt, Pipfile or go.mod here. haau3 init sets up a project; it does not start one.",
        next: LANGUAGES.map((language) => START[language]),
      }),
      text: "",
      exit: EXIT.failed,
    };
  }
  let language: Language;
  if (options.language !== undefined) {
    language = options.language as Language;
    if (!project.languages.includes(language)) {
      return {
        document: failure(COMMAND, {
          code: "no-project",
          message: `--language ${language} needs ${MANIFESTS[language]} here, and there is none. haau3 init sets up a project; it does not start one.`,
          next: [START[language]],
        }),
        text: "",
        exit: EXIT.failed,
      };
    }
  } else if (project.languages.length === 1) {
    language = project.languages[0]!;
  } else {
    const picked = await choose(ctx, "This folder holds more than one kind of project. Which one should haau3 set up?", project.languages.map((l) => `${l}: ${LANGUAGE_NAME[l]}`), false);
    if (!picked) {
      return choiceNeeded(
        `This folder holds a ${list(project.languages.map((l) => LANGUAGE_NAME[l]))} project. Name the one to set up with --language.`,
        project.languages.map((l) => ({ command: rerun(options, { language: l }), description: `Set up the ${LANGUAGE_NAME[l]} project.` })),
      );
    }
    language = project.languages[picked[0]!]!;
  }

  // The package manager: the one the project's files name, or the one chosen.
  let flagged: Manager | undefined;
  if (options.packageManager !== undefined) {
    const manager = managerFor(language, options.packageManager);
    if (!manager) {
      return misused(COMMAND, {
        code: "invalid-package-manager",
        message: `--package-manager ${options.packageManager} is not one for a ${LANGUAGE_NAME[language]} project. Use ${list([...MANAGERS[language]])}.`,
        next: [],
      });
    }
    flagged = manager;
  }
  const detected = detectManager({ language, cwd: folder, env: ctx.env, home, flag: flagged, platform });
  let found: ManagerFound;
  if (detected.ok) {
    found = detected.found;
  } else {
    const question = `This project's files name more than one package manager (${list(detected.evidence)}). Which one installs its packages?`;
    const picked = await choose(ctx, question, detected.candidates.map((m) => MANAGER_NAME[m]), false);
    if (!picked) {
      return choiceNeeded(
        `This project's files name more than one package manager (${list(detected.evidence)}). Name the one it uses with --package-manager.`,
        detected.candidates.map((m) => ({
          command: rerun(options, { language: project.languages.length > 1 ? language : options.language, packageManager: m }),
          description: `Install with ${MANAGER_NAME[m]}.`,
        })),
      );
    }
    found = { manager: detected.candidates[picked[0]!]!, how: "flag", evidence: null, folder };
  }

  // The coding agents: the ones named, else the ones found, else the ones chosen.
  let agents: Agent[];
  /** Why each agent is set up: named with --agent, found (and by what), or picked. */
  let agentsBy: Record<string, string> = {};
  if (options.noAgent) {
    agents = [];
  } else if (options.agents.length > 0) {
    agents = AGENTS.filter((agent) => options.agents.includes(agent));
    agentsBy = Object.fromEntries(agents.map((agent) => [agent, "--agent"]));
  } else {
    const detectedBy = detectAgents(folder, ctx.env);
    agents = detectedBy.map((d) => d.agent);
    agentsBy = Object.fromEntries(detectedBy.map((d) => [d.agent, d.by]));
    if (agents.length === 0) {
      const none = "None: only the SDK and the env file";
      const picked = await choose(
        ctx,
        "No coding agent was found in this project. Which ones should haau3 set up? It adds the haau3 skill and the docs' MCP server for each.",
        [...AGENTS.map((agent) => AGENT_NAMES[agent]), none],
        true,
      );
      if (!picked) {
        // The language goes in the command too when the folder needed it named.
        const keep = { language: project.languages.length > 1 ? language : options.language };
        return choiceNeeded(
          `No coding agent was found in this project. Name each one to set up with --agent (${list([...AGENTS])}), or set up none with --no-agent.`,
          [
            { command: rerun(options, { ...keep, agents: ["claude-code"] }), description: `Set up Claude Code. Give --agent once for each agent: ${list([...AGENTS])}.` },
            { command: rerun(options, { ...keep, noAgent: true }), description: "Set up no coding agent: only the SDK and the env file." },
          ],
        );
      }
      agents = picked.filter((i) => i < AGENTS.length).map((i) => AGENTS[i]!);
      agentsBy = Object.fromEntries(agents.map((agent) => [agent, "picked"]));
    }
  }

  // Then the changes, each reported.
  const checks: InitCheck[] = [];
  const changed: Changed[] = [];
  const manifest = manifestOf(folder, language);
  checks.push(check("language", "pass", `A ${LANGUAGE_NAME[language]} project, by its ${manifest}.`, [], { language, languages: project.languages, manifest }));
  checks.push(managerCheck(found, folder));

  const sdk = await sdkStep(ctx, project, language, found, folder, platform, options);
  checks.push(sdk.check);
  changed.push(...sdk.changed);
  const skill = await skillStep(ctx, agents, docs.docsURL, folder, options);
  checks.push(skill.check);
  changed.push(...skill.changed);
  const mcp = mcpStep(agents, docs.docsURL, folder);
  checks.push(mcp.check);
  changed.push(...mcp.changed);
  const env = await envStep(ctx, folder, options, platform);

  const how = loader(language, found.manager, env.shown, readsEnvLocal(folder));
  if (env.check.status === "pass" || env.check.status === "skip") env.check.message = `${env.check.message} ${how.note}`;
  checks.push(env.check);

  // What to run next: the fixes first, then the way from here to a working call.
  const settings = findSettings({ cwd: folder, env: ctx.env, file: options.file });
  const keyed = settings.key !== null || sandboxNamed(settings);
  const failedChecks = checks.filter((c) => c.status === "fail");
  const warned = checks.filter((c) => c.status === "warn");
  const keysStep = options.file === undefined ? KEYS_CREATE_STEP : keysCreateStep({ file: options.file }, KEYS_CREATE_STEP.description);
  const onward = keyed ? [doctorStep(options.file)] : [TEST_STEP, LOGIN_STEP, keysStep, doctorStep(options.file)];
  const next = unique([...failedChecks.flatMap((c) => c.next), ...warned.flatMap((c) => c.next), ...(how.step ? [how.step] : []), ...onward]);

  const data = {
    language,
    packageManager: found.manager,
    agents,
    agentsBy,
    envFile: env.shown,
    checks,
    changed,
    next,
  };

  const lines = [`Set up this ${LANGUAGE_NAME[language]} project for haau3.`, "", ...checks.map(lineOf), ""];
  lines.push(changed.length ? `Changed:\n${changed.map((c) => `  ${c.action.padEnd(7)}  ${c.file}`).join("\n")}` : "Changed nothing: it was already set up.", "");
  if (failedChecks.length === 0) {
    lines.push(warned.length === 0 ? "Set up." : `Set up, with ${warned.length} warning${warned.length === 1 ? "" : "s"}.`);
    lines.push("", "Next:", ...next.map((step) => `  ${step.command}\n    ${step.description}`));
    return { document: success(COMMAND, data), text: `${lines.join("\n")}\n`, exit: EXIT.ok };
  }

  let error: CliError;
  const envOnly = failedChecks.length === 1 && failedChecks[0]!.name === "env-file-ignored" && env.gitignore;
  if (envOnly) {
    error = {
      code: env.tracked ? "env-file-tracked" : "env-file-not-ignored",
      message: env.tracked
        ? `git tracks ${env.shown}, so a key in it would be committed. Stop tracking it, then add this line to ${env.gitignore!.file}:\n  ${env.gitignore!.line}`
        : `git does not ignore ${env.shown}, so a key written there could be committed. Add this line to ${env.gitignore!.file}:\n  ${env.gitignore!.line}`,
      next: unique(failedChecks.flatMap((c) => c.next)),
      gitignore: env.gitignore!,
    };
  } else {
    const names = failedChecks.map((c) => c.name).join(", ");
    error = {
      code: "not-set-up",
      message: `Not set up: ${failedChecks.length} step${failedChecks.length === 1 ? "" : "s"} failed (${names}).`,
      next: unique(failedChecks.flatMap((c) => c.next)),
      ...(env.gitignore ? { gitignore: env.gitignore } : {}),
    };
  }
  const notFailed = next.filter((step) => !error.next.some((n) => n.command === step.command));
  if (notFailed.length) lines.push("Then:", ...notFailed.map((step) => `  ${step.command}\n    ${step.description}`), "");
  return { document: failure(COMMAND, error, null, data), text: `${lines.join("\n")}\n`, exit: EXIT.failed };
}

function managerCheck(found: ManagerFound, folder: string): InitCheck {
  const name = MANAGER_NAME[found.manager];
  const details = { packageManager: found.manager, how: found.how, evidence: found.evidence, folder: relative(folder, found.folder) || "." };
  const why: Record<ManagerFound["how"], string> = {
    flag: "as chosen",
    "package-manager-field": `as ${found.evidence ?? "package.json"} names it in packageManager`,
    lockfile: `by ${found.evidence ?? "its lockfile"}`,
    "project-file": `by ${found.evidence ?? "the project's files"}`,
    "ran-init": "the tool that ran this command, since no lockfile names one",
    default: found.manager === "pip" ? "since no uv, Poetry or Pipenv file is here" : "since nothing here names another",
  };
  return check("package-manager", "pass", `${name}, ${why[found.how]}.`, [], details);
}
