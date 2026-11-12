// What the project in the current folder is built with, read from its own files and nothing else:
// which language's manifest it has, whether it depends on haau3's SDK for that language and at which
// version, and the Node version the SDK needs. Nothing is executed and no registry is asked, so the
// answer is what the files say, which is what the next install will follow.
//
// Every manifest is read a line at a time, each line at most LINE_MAX characters, with patterns that
// cannot backtrack: a crafted file is skipped, never a hang.
import { readdirSync, statSync } from "node:fs";
import { dirname, join, parse, resolve } from "node:path";
import { readSmallText } from "./files.js";

export type Language = "node" | "python" | "go";

/** The first release of each SDK in which the key's mode picks the host, which doctor's advice assumes. */
export const SDK_FLOORS: Readonly<Record<Language, { package: string; floor: string; install: string }>> = {
  node: { package: "@haau3/sdk", floor: "0.4.0", install: "npm install @haau3/sdk" },
  python: { package: "haau3", floor: "0.4.0", install: "pip install haau3" },
  go: { package: "github.com/haau3/haau3-go", floor: "v0.3.0", install: "go get github.com/haau3/haau3-go" },
};

/** The Node version @haau3/sdk needs when its own package does not say: its engines field on 0.4.0. */
export const DEFAULT_NODE_FLOOR = 22;

/**
 * How a declared version stands against the floor:
 * - `below`: every version it allows is older.
 * - `allows-below`: it allows older versions as well as newer ones.
 * - `ok`: none it allows is older.
 * - `null`: it names no version haau3 can read.
 */
export type FloorVerdict = "below" | "allows-below" | "ok" | null;

/** One SDK the project depends on, as its files say. */
export interface SdkFound {
  language: Language;
  package: string;
  /** The file that names it, as printed. */
  manifest: string;
  /** The version or range as written, when it is safe to print; null when none or not printable. */
  declared: string | null;
  /** The version installed, read from node_modules; Node only. */
  installed: string | null;
  /** The installed copy is in a folder above this one, as in a workspace. */
  installedAbove: boolean;
  floor: string;
  /** The installed version against the floor when there is one, else the declared range's. */
  verdict: FloorVerdict;
}

export interface Project {
  /** The languages whose manifests are in the folder. */
  languages: Language[];
  sdks: SdkFound[];
  /** The Node version the installed @haau3/sdk asks for, as a major: only when the project declares the SDK. */
  nodeFloor: number | null;
}

/** A manifest bigger than this is not read. */
const MAX_MANIFEST_BYTES = 1024 * 1024;
/** A line longer than this is no dependency line any tool writes, and is skipped. */
const LINE_MAX = 500;

function readSmall(path: string): string | null {
  const read = readSmallText(path, MAX_MANIFEST_BYTES);
  return read.state === "read" ? read.text.replace(/^\uFEFF/, "") : null;
}

/** A manifest's lines, each short enough to match, comments still on them. */
function lines(text: string): string[] {
  return text.split(/\r?\n|\r/).filter((line) => line.length <= LINE_MAX);
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** A version or range that can be printed: version characters only, short, and never a key. */
const PRINTABLE = /^[A-Za-z0-9.^~<>=!*|,+ -]{1,40}$/;

function printable(spec: string | undefined | null): string | null {
  if (spec === undefined || spec === null) return null;
  const trimmed = spec.trim();
  if (!trimmed || !PRINTABLE.test(trimmed) || /haau3_sk_/i.test(trimmed)) return null;
  return trimmed;
}

type Version = [number, number, number];

/** The first version number in a string: `^0.3.9` gives 0.3.9, `v0.3.0` 0.3.0, `>=0.4` 0.4.0. Only its first 64 characters are read. */
export function firstVersion(text: string): Version | null {
  const match = /(\d{1,9})\.(\d{1,9})(?:\.(\d{1,9}))?/.exec(text.slice(0, 64));
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
}

export function below(version: Version, floor: Version): boolean {
  for (let i = 0; i < 3; i++) {
    if (version[i]! !== floor[i]!) return version[i]! < floor[i]!;
  }
  return false;
}

/** One version: older than the floor or not; null when it names none. */
function versionVerdict(version: string | null, floor: string): FloorVerdict {
  const parsed = version === null ? null : firstVersion(version);
  if (!parsed) return null;
  return below(parsed, firstVersion(floor)!) ? "below" : "ok";
}

/**
 * A declared range against the floor, clause by clause (`>=0.3,<0.5`, `^0.3.9`, `~=0.3`):
 * the lowest version it allows and the highest it caps at.
 */
function rangeVerdict(spec: string | null, floor: string): FloorVerdict {
  if (spec === null) return null;
  const floorV = firstVersion(floor)!;
  let lowest: Version | null = null;
  let open = false;
  let cap: { version: Version; inclusive: boolean } | null = null;
  // `>= 0.3` is one clause: the space after an operator goes before the range is split.
  for (const raw of spec.replace(/([<>=!~^]+)[ \t]+/g, "$1").split(/[,\s]+|\|\|/).filter(Boolean)) {
    const clause = raw.trim();
    const version = firstVersion(clause);
    if (!version) continue;
    if (/^</.test(clause)) {
      cap = { version, inclusive: clause.startsWith("<=") };
      continue;
    }
    if (/^!=/.test(clause)) continue;
    lowest = version;
    if (/^(>=|>)/.test(clause)) open = true;
    else if (/^~=/.test(clause)) open = true;
    else if (/^\^/.test(clause)) {
      // npm's and Poetry's caret keeps the leftmost non-zero part: ^0.3.9 is below 0.4.0, ^1.2 below 2.
      const top: Version = version[0] > 0 ? [version[0] + 1, 0, 0] : version[1] > 0 ? [0, version[1] + 1, 0] : [0, 0, version[2] + 1];
      cap = { version: top, inclusive: false };
    } else if (/^~/.test(clause)) {
      cap = { version: [version[0], version[1] + 1, 0], inclusive: false };
    }
  }
  if (cap && (below(cap.version, floorV) || (!cap.inclusive && !below(floorV, cap.version)))) return "below";
  if (!lowest) return null;
  if (!below(lowest, floorV)) return "ok";
  return open ? "allows-below" : "below";
}

// --- Node ----------------------------------------------------------------------------------------

const NODE_FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];

/** The installed @haau3/sdk's package.json, looked for in node_modules from this folder up, as Node resolves it. */
function installedNodeSdk(folder: string): { version: string | null; engines: string | null; above: boolean } | null {
  const start = resolve(folder);
  let at = start;
  for (;;) {
    const text = readSmall(join(at, "node_modules", "@haau3", "sdk", "package.json"));
    if (text !== null) {
      try {
        const manifest = JSON.parse(text) as { version?: unknown; engines?: { node?: unknown } };
        return {
          version: typeof manifest.version === "string" ? manifest.version.slice(0, 64) : null,
          engines: typeof manifest.engines?.node === "string" ? manifest.engines.node.slice(0, 64) : null,
          above: at !== start,
        };
      } catch {
        return { version: null, engines: null, above: at !== start };
      }
    }
    const up = dirname(at);
    if (up === at || parse(at).root === at) return null;
    at = up;
  }
}

function nodeSdk(folder: string): { found: SdkFound | null; nodeFloor: number | null } {
  const text = readSmall(join(folder, "package.json"));
  let declared: string | undefined;
  if (text !== null) {
    try {
      const manifest = JSON.parse(text) as Record<string, unknown>;
      for (const field of NODE_FIELDS) {
        const deps = manifest[field];
        if (deps && typeof deps === "object" && typeof (deps as Record<string, unknown>)["@haau3/sdk"] === "string") {
          declared = (deps as Record<string, string>)["@haau3/sdk"];
          break;
        }
      }
    } catch {
      // A package.json that does not parse names nothing.
    }
  }
  // A copy in a folder above counts only for a project that names the SDK: one a parent installed for
  // itself says nothing about this project.
  if (declared === undefined) return { found: null, nodeFloor: null };
  const installed = installedNodeSdk(folder);
  const engines = installed?.engines ? firstVersion(`${installed.engines}.0`) : null;
  const { floor } = SDK_FLOORS.node;
  const installedVersion = printable(installed?.version ?? null);
  const declaredPrintable = printable(declared);
  return {
    found: {
      language: "node",
      package: SDK_FLOORS.node.package,
      manifest: "package.json",
      declared: declaredPrintable,
      installed: installedVersion,
      installedAbove: installed?.above ?? false,
      floor,
      verdict: installedVersion ? versionVerdict(installedVersion, floor) : rangeVerdict(declaredPrintable, floor),
    },
    nodeFloor: engines ? engines[0] : null,
  };
}

// --- Python --------------------------------------------------------------------------------------

/**
 * The version part of a requirement on haau3, or undefined when the requirement is not haau3's. The
 * name is matched whole, so haau3x is not it. A marker (`; python_version…`), pip's options
 * (` --hash=…`) and a line continuation are cut first, as pip reads them.
 */
function pythonRequirement(requirement: string): string | undefined {
  let text = requirement;
  for (const cut of [";", " --", "\t--", " #"]) {
    const at = text.indexOf(cut);
    if (at !== -1) text = text.slice(0, at);
  }
  text = text.replace(/\\$/, "").trim();
  if (!/^haau3(?![A-Za-z0-9._-])/i.test(text)) return undefined;
  let rest = text.slice("haau3".length).trim();
  if (rest.startsWith("[")) {
    const close = rest.indexOf("]");
    if (close === -1) return undefined;
    rest = rest.slice(close + 1).trim();
  }
  // `haau3 @ git+https://…`: a direct reference names no version.
  if (rest.startsWith("@")) return "";
  return rest;
}

function pythonRequirementFiles(folder: string): string[] {
  try {
    return readdirSync(folder)
      .filter((name) => /^requirements[\w.-]{0,64}\.(txt|in)$/i.test(name) && !/haau3_sk_/i.test(name))
      .sort();
  } catch {
    return [];
  }
}

/** The tables of a TOML file a line at a time: each line with the table it is in. */
function tomlLines(text: string): { table: string; line: string }[] {
  let table = "";
  const out: { table: string; line: string }[] = [];
  for (const raw of lines(text)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const header = /^\[\[?([^\]]{1,200})\]\]?$/.exec(line);
    if (header) {
      table = header[1]!.trim().replace(/["']/g, "");
      continue;
    }
    out.push({ table, line });
  }
  return out;
}

/** A TOML entry `haau3 = "…"` or `haau3 = { version = "…" }`: its version, or undefined. */
function tomlVersionEntry(line: string): string | undefined {
  const entry = /^haau3[ \t]*=[ \t]*(.{0,300})$/i.exec(line);
  if (!entry) return undefined;
  const value = entry[1]!.trim();
  const quoted = /^["']([^"']{0,100})["']/.exec(value);
  if (quoted) return quoted[1]!;
  const version = /version[ \t]*=[ \t]*["']([^"']{0,100})["']/.exec(value);
  return version ? version[1]! : "";
}

function pythonSdk(folder: string): SdkFound | null {
  const { floor, package: name } = SDK_FLOORS.python;
  const found = (manifest: string, spec: string | undefined): SdkFound => {
    const declared = printable(spec ?? null);
    return { language: "python", package: name, manifest, declared, installed: null, installedAbove: false, floor, verdict: rangeVerdict(declared, floor) };
  };

  const pyproject = readSmall(join(folder, "pyproject.toml"));
  if (pyproject !== null) {
    // PEP 621, uv and dependency groups: requirement strings inside an array whose key or table names
    // dependencies. Poetry: `haau3 = …` in a dependencies table. Anything else, such as keywords, is not.
    let inArray = false;
    for (const { table, line } of tomlLines(pyproject)) {
      const opens = /^[A-Za-z0-9_.-]{0,100}dependencies[ \t]*=[ \t]*\[/i.test(line) || (/(dependencies|dependency-groups)$/i.test(table) && /^[A-Za-z0-9_.-]{1,100}[ \t]*=[ \t]*\[/.test(line));
      if (opens) inArray = true;
      if (inArray) {
        for (const match of line.matchAll(/["']([^"'\n]{1,300})["']/g)) {
          const spec = pythonRequirement(match[1]!);
          if (spec !== undefined) return found("pyproject.toml", spec);
        }
        if (line.includes("]")) inArray = false;
        continue;
      }
      if (/^tool\.poetry\.(?:group\.[^.]{1,100}\.)?(?:dev-)?dependencies$/i.test(table)) {
        const spec = tomlVersionEntry(line);
        if (spec !== undefined) return found("pyproject.toml", spec);
      }
    }
  }
  for (const file of pythonRequirementFiles(folder)) {
    const text = readSmall(join(folder, file));
    if (text === null) continue;
    for (const line of lines(text)) {
      const trimmed = line.trim();
      if (trimmed.startsWith("#") || trimmed.startsWith("-")) continue;
      const spec = pythonRequirement(trimmed);
      if (spec !== undefined) return found(file, spec);
    }
  }
  const pipfile = readSmall(join(folder, "Pipfile"));
  if (pipfile !== null) {
    for (const { table, line } of tomlLines(pipfile)) {
      if (table !== "packages" && table !== "dev-packages") continue;
      const spec = tomlVersionEntry(line);
      if (spec !== undefined) return found("Pipfile", spec === "*" ? "" : spec);
    }
  }
  return null;
}

// --- Go ------------------------------------------------------------------------------------------

function goSdk(folder: string): SdkFound | null {
  const text = readSmall(join(folder, "go.mod"));
  if (text === null) return null;
  const { floor, package: name } = SDK_FLOORS.go;
  // In a require block or on a require line, never in exclude, replace or retract; go.mod's versions are exact.
  let block = "";
  for (const raw of lines(text)) {
    const line = raw.replace(/\/\/.*$/, "").trim();
    if (!line) continue;
    if (line === ")") {
      block = "";
      continue;
    }
    const opens = /^(require|exclude|replace|retract)[ \t]*\($/.exec(line);
    if (opens) {
      block = opens[1]!;
      continue;
    }
    const single = /^require[ \t]+(.{1,300})$/.exec(line);
    const entry = single ? single[1]! : block === "require" ? line : null;
    if (entry === null) continue;
    const match = /^github\.com\/haau3\/haau3-go[ \t]+(v\d[\w.+-]{0,60})/.exec(entry);
    if (match) {
      const declared = printable(match[1]);
      return { language: "go", package: name, manifest: "go.mod", declared, installed: null, installedAbove: false, floor, verdict: versionVerdict(declared, floor) };
    }
  }
  return null;
}

// --- The project ---------------------------------------------------------------------------------

export function readProject(cwd: string): Project {
  const folder = resolve(cwd);
  const languages: Language[] = [];
  if (isFile(join(folder, "package.json"))) languages.push("node");
  if (["pyproject.toml", "Pipfile", "setup.py", "setup.cfg"].some((name) => isFile(join(folder, name))) || pythonRequirementFiles(folder).length > 0) {
    languages.push("python");
  }
  if (isFile(join(folder, "go.mod"))) languages.push("go");

  const node = nodeSdk(folder);
  const sdks = [node.found, pythonSdk(folder), goSdk(folder)].filter((sdk): sdk is SdkFound => sdk !== null);
  return { languages, sdks, nodeFloor: node.nodeFloor };
}
