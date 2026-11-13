// Which package manager a project installs with, read from its own files, and the one command each
// has that adds haau3's SDK and edits the manifest itself. haau3 never edits a manifest by hand: pip
// has no such command, so a pip project is told what to add instead.
//
// Node: the packageManager field (the field Corepack reads), then the lockfile, in the project's folder
// or the nearest folder above it that has either, as in a workspace; then the tool that ran this
// command (`pnpm dlx`, `yarn dlx`, `bunx`, `npx`); else npm. Python: uv's, Poetry's and Pipenv's own
// files; else pip. Go: go. Two that disagree, such as two lockfiles, are a choice for the person.
import { statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { readSmallText } from "./files.js";
import { sameFolder } from "./git.js";
import type { Language } from "./project.js";

export const NODE_MANAGERS = ["npm", "pnpm", "yarn", "bun"] as const;
export const PYTHON_MANAGERS = ["uv", "poetry", "pipenv", "pip"] as const;
export type Manager = (typeof NODE_MANAGERS)[number] | (typeof PYTHON_MANAGERS)[number] | "go";

export const MANAGERS: Readonly<Record<Language, readonly Manager[]>> = { node: NODE_MANAGERS, python: PYTHON_MANAGERS, go: ["go"] };

/** Each manager's command that adds the SDK and records it in the manifest; null for pip, which records nothing. */
export const ADD: Readonly<Record<Manager, readonly string[] | null>> = {
  npm: ["install", "@haau3/sdk"],
  pnpm: ["add", "@haau3/sdk"],
  yarn: ["add", "@haau3/sdk"],
  bun: ["add", "@haau3/sdk"],
  uv: ["add", "haau3"],
  poetry: ["add", "haau3"],
  pipenv: ["install", "haau3"],
  pip: null,
  go: ["get", "github.com/haau3/haau3-go@latest"],
};

/** The command that moves the SDK to its newest version, for a project that requires an older one. */
export const UPGRADE: Readonly<Record<Manager, string>> = {
  npm: "npm install @haau3/sdk@latest",
  pnpm: "pnpm add @haau3/sdk@latest",
  yarn: "yarn add @haau3/sdk@latest",
  bun: "bun add @haau3/sdk@latest",
  uv: "uv add haau3 --upgrade-package haau3",
  poetry: "poetry add haau3@latest",
  pipenv: "pipenv upgrade haau3",
  pip: "pip install --upgrade haau3",
  go: "go get github.com/haau3/haau3-go@latest",
};

/** How the manager was chosen. */
export type How = "flag" | "package-manager-field" | "lockfile" | "project-file" | "ran-init" | "default";

export interface ManagerFound {
  manager: Manager;
  how: How;
  /** The file that says so, relative to the project's folder, or null. */
  evidence: string | null;
  /** The folder that file is in: the project's, or one above it in a workspace. */
  folder: string;
}

export type ManagerResult =
  | { ok: true; found: ManagerFound }
  /** The project's files name more than one. */
  | { ok: false; candidates: Manager[]; evidence: string[] };

const NODE_LOCKFILES: readonly [string, Manager][] = [
  ["package-lock.json", "npm"],
  ["npm-shrinkwrap.json", "npm"],
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
];

const PYTHON_LOCKFILES: readonly [string, Manager][] = [
  ["uv.lock", "uv"],
  ["poetry.lock", "poetry"],
  ["Pipfile.lock", "pipenv"],
];

/** The files a manager writes when it adds the SDK, which `init` reports when they change. */
export const MANIFEST_FILES: readonly string[] = [
  "package.json",
  ...NODE_LOCKFILES.map(([name]) => name),
  // Yarn's Plug'n'Play files, which take node_modules' place.
  ".pnp.cjs",
  ".pnp.loader.mjs",
  "pyproject.toml",
  "requirements.txt",
  "Pipfile",
  ...PYTHON_LOCKFILES.map(([name]) => name),
  "go.mod",
  "go.sum",
];

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function exists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

/** The packageManager field's manager, when it names one of the four. */
function packageManagerField(folder: string): Manager | null {
  const read = readSmallText(join(folder, "package.json"), 1024 * 1024);
  if (read.state !== "read") return null;
  try {
    const field = (JSON.parse(read.text.replace(/^\uFEFF/, "")) as { packageManager?: unknown }).packageManager;
    if (typeof field !== "string") return null;
    const name = /^(npm|pnpm|yarn|bun)@/.exec(field.trim());
    return name ? (name[1] as Manager) : null;
  } catch {
    return null;
  }
}

/** The tool that ran this command, by the user agent npm, pnpm, yarn and bun give the programs they run. */
function ranBy(env: NodeJS.ProcessEnv): Manager | null {
  const name = /^(npm|pnpm|yarn|bun)\//.exec(env.npm_config_user_agent?.trim() ?? "");
  return name ? (name[1] as Manager) : null;
}

/** A file as printed: relative to the project's folder, such as ../../pnpm-lock.yaml in a workspace. */
function shown(folder: string, cwd: string, name: string): string {
  return sameFolder(folder, cwd, process.platform) ? name : relative(cwd, join(folder, name));
}

/**
 * The folders a project can share files with: its own, then each above it inside the same
 * repository, up to its top folder (the one holding .git). Never the home folder, any folder above
 * it, or anything above a project outside a repository, so a stray file there is never the project's.
 */
export function upward(cwd: string, home: string, platform: NodeJS.Platform): string[] {
  const start = resolve(cwd);
  const folders: string[] = [start];
  if (!exists(join(start, ".git")) && !repositoryAbove(start, home, platform)) return folders;
  let at = start;
  while (!exists(join(at, ".git"))) {
    const up = dirname(at);
    if (up === at || sameFolder(up, home, platform)) break;
    at = up;
    folders.push(at);
  }
  return folders;
}

/** Whether a folder above, below the home folder, holds a repository. */
function repositoryAbove(start: string, home: string, platform: NodeJS.Platform): boolean {
  let at = dirname(start);
  while (at !== dirname(at) && !sameFolder(at, home, platform)) {
    if (exists(join(at, ".git"))) return true;
    at = dirname(at);
  }
  return false;
}

/**
 * The manager the files name, nearest folder first. A folder above counts only where it is a project
 * itself (`manifest` there): a workspace's top, whose lockfile its members share.
 */
function fromFiles(
  folders: string[],
  cwd: string,
  lockfiles: readonly [string, Manager][],
  local: (folder: string) => [string, Manager][],
  manifest: string,
): ManagerResult | null {
  for (const folder of folders) {
    const own = folder === folders[0];
    if (!own && !isFile(join(folder, manifest))) continue;
    const found: [string, Manager][] = [...(own ? local(folder) : []), ...lockfiles.filter(([name]) => isFile(join(folder, name)))];
    const managers = [...new Set(found.map(([, manager]) => manager))];
    if (managers.length === 1) {
      const [name, manager] = found[0]!;
      const how = [...NODE_LOCKFILES, ...PYTHON_LOCKFILES].some(([file]) => file === name) ? "lockfile" : "project-file";
      return { ok: true, found: { manager, how, evidence: shown(folder, cwd, name), folder } };
    }
    if (managers.length > 1) return { ok: false, candidates: managers, evidence: found.map(([name]) => shown(folder, cwd, name)) };
  }
  return null;
}

export function detectManager({
  language,
  cwd,
  env,
  home,
  flag,
  platform = process.platform,
}: {
  language: Language;
  cwd: string;
  env: NodeJS.ProcessEnv;
  home: string;
  /** The manager named with --package-manager, already checked against the language. */
  flag?: Manager | undefined;
  platform?: NodeJS.Platform;
}): ManagerResult {
  const folder = resolve(cwd);
  if (flag) return { ok: true, found: { manager: flag, how: "flag", evidence: null, folder } };
  if (language === "go") return { ok: true, found: { manager: "go", how: "project-file", evidence: "go.mod", folder } };
  const folders = upward(folder, home, platform);

  if (language === "node") {
    // The field decides when it is there: Corepack refuses any other manager in that project.
    for (const at of folders) {
      const field = packageManagerField(at);
      if (field) return { ok: true, found: { manager: field, how: "package-manager-field", evidence: shown(at, folder, "package.json"), folder: at } };
      if (NODE_LOCKFILES.some(([name]) => isFile(join(at, name))) && isFile(join(at, "package.json"))) break;
    }
    const files = fromFiles(folders, folder, NODE_LOCKFILES, () => [], "package.json");
    if (files) return files;
    const ran = ranBy(env);
    if (ran) return { ok: true, found: { manager: ran, how: "ran-init", evidence: null, folder } };
    return { ok: true, found: { manager: "npm", how: "default", evidence: null, folder } };
  }

  // Python: in the project's own folder, every tool's lockfile, its Pipfile and pyproject.toml's tool
  // tables; above it, only a uv workspace's uv.lock. Poetry and Pipenv in a folder above would edit
  // that folder's project, not this one.
  const above = PYTHON_LOCKFILES.filter(([name]) => name === "uv.lock");
  const files = fromFiles(folders, folder, above, (at) => {
    const local: [string, Manager][] = PYTHON_LOCKFILES.filter(([name]) => name !== "uv.lock" && isFile(join(at, name)));
    if (isFile(join(at, "Pipfile"))) local.push(["Pipfile", "pipenv"]);
    const pyproject = readSmallText(join(at, "pyproject.toml"), 1024 * 1024);
    if (pyproject.state === "read") {
      const lines = pyproject.text.split(/\r?\n/).filter((line) => line.length <= 500);
      if (lines.some((line) => /^\s*\[tool\.poetry[.\]]/.test(line))) local.push(["pyproject.toml", "poetry"]);
      if (lines.some((line) => /^\s*\[tool\.uv[.\]]/.test(line))) local.push(["pyproject.toml", "uv"]);
    }
    return local;
  }, "pyproject.toml");
  if (files) return files;
  return { ok: true, found: { manager: "pip", how: "default", evidence: null, folder } };
}

/** A manager named with --package-manager, when it is one this language has. */
export function managerFor(language: Language, name: string): Manager | null {
  return (MANAGERS[language] as readonly string[]).includes(name) ? (name as Manager) : null;
}

/** Every manager's name, for a flag's refusal. */
export const ALL_MANAGERS: readonly Manager[] = [...NODE_MANAGERS, ...PYTHON_MANAGERS, "go"];
