// `haau3 doctor`: is this project ready to call the API? It runs the same checks in the same order
// every time, each a name, a status (pass, warn, fail, or skip when it waits on another), a message
// and the commands that fix it. It reads the project's files and settings where the application will,
// lets @haau3/sdk decide where a call goes, and proves it with two calls: /health, which needs no key,
// and one read of the FHIR base's metadata, which counts toward no plan. It never prints a key, a
// value it found under another name, or a response body.
import { AuthError, ForbiddenError, Haau3, Haau3Error, NoAnswerError, RefusedError } from "@haau3/sdk";
import { basename, dirname, join } from "node:path";
import { fileFlagError, printablePath, shownPath } from "../envfile.js";
import { checkAddress, ENVIRONMENT_ADDRESSES, resolvePlatform, type Environment } from "../environment.js";
import { gitAnswer } from "../git.js";
import { modeOf, wellFormed, type KeyMode } from "../key.js";
import { failure, success, EXIT, type NextStep, type Problem } from "../output.js";
import { DEFAULT_NODE_FLOOR, readProject, SDK_FLOORS, type Language, type Project } from "../project.js";
import { BASE_URL_VARIABLE, ENVIRONMENT_VARIABLE, findSettings, KEY_VARIABLE, where, type EnvFile, type Found, type Settings } from "../settings.js";
import { VERSION } from "../version.js";
import { holdsSecret } from "../signin/http.js";
import { holdsKey } from "../signin/keys.js";
import { arg, COMPLETE_STEP, doctorStep, fileFlag, KEYS_CREATE_STEP, LOGIN_STEP, misused, when, type Context, type Result } from "./context.js";
import { gitignoreLine } from "./keys.js";

const COMMAND = "doctor";

/** Every check, in the order each run lists them. */
export const CHECKS = ["node", "sdk", "key", "near-miss", "env-file-ignored", "settings", "reachable", "key-works", "signed-in"] as const;
export type CheckName = (typeof CHECKS)[number];
export type CheckStatus = "pass" | "warn" | "fail" | "skip";

export interface Check {
  name: CheckName;
  status: CheckStatus;
  /** What was found, for a person. */
  message: string;
  /** The commands that fix it, in order; empty when it passed or nothing is to be run. */
  next: NextStep[];
  /** What was found, for a program. Never a key, a value found under another name, or a body. */
  details: Record<string, unknown>;
}

export interface DoctorOptions {
  /** An env file to read in place of .env.local and .env, as given with --file. */
  file: string | undefined;
}

/** How long each call may take: an instance of the API that was asleep can take up to about 30 s to start. */
export const CALL_TIMEOUT_MS = 30_000;

const COLD_START = "An instance of the API may have been starting, which can take up to about 30 seconds. Run this again.";

const NAMED: Readonly<Record<Environment, string>> = { production: "production", sandbox: "the Sandbox" };

/** A name as it starts a sentence: "the Sandbox" becomes "The Sandbox". */
const sentence = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

const check = (name: CheckName, status: CheckStatus, message: string, next: NextStep[] = [], details: Record<string, unknown> = {}): Check => ({
  name,
  status,
  message,
  next,
  details,
});
const skip = (name: CheckName, waitsOn: CheckName, why: string): Check => check(name, "skip", `Waits on ${waitsOn}: ${why}`, [], { waitsOn });

/** A command that reruns keys create with the same file, for a key that has to be made again. */
function keysCreateStep(options: { test?: boolean; replace?: boolean; file?: string | undefined }, description: string): NextStep {
  const parts = ["npx haau3 keys create"];
  if (options.test) parts.push("--test");
  if (options.file !== undefined) parts.push(fileFlag(options.file));
  if (options.replace) parts.push("--replace");
  return { command: parts.join(" "), description };
}

/** Setting the Sandbox as the environment, in this shell's own words. */
function sandboxStep(platform: NodeJS.Platform): NextStep {
  return {
    command: platform === "win32" ? `$env:${ENVIRONMENT_VARIABLE} = "sandbox"` : `export ${ENVIRONMENT_VARIABLE}=sandbox`,
    description: `Or call the Sandbox with no key: set ${ENVIRONMENT_VARIABLE}=sandbox where the app reads its settings, such as its env file.`,
  };
}

// --- node and sdk --------------------------------------------------------------------------------

function nodeCheck(project: Project): Check {
  const version = process.versions.node;
  if (!project.languages.includes("node")) return check("node", "skip", "Not a Node project: there is no package.json here.", [], { version });
  const floor = project.nodeFloor ?? DEFAULT_NODE_FLOOR;
  const major = Number(version.split(".")[0]);
  const details = { version, required: floor };
  if (major >= floor) return check("node", "pass", `Node ${version}, and @haau3/sdk needs ${floor} or newer.`, [], details);
  return check("node", "fail", `Node ${version}, and @haau3/sdk needs ${floor} or newer. Install Node ${floor} or newer.`, [], details);
}

const UPGRADE: Readonly<Record<Language, string>> = {
  node: "npm install @haau3/sdk@latest",
  python: "pip install --upgrade haau3",
  go: "go get github.com/haau3/haau3-go@latest",
};

const LANGUAGE_NAME: Readonly<Record<Language, string>> = { node: "TypeScript or JavaScript", python: "Python", go: "Go" };

function sdkCheck(project: Project): Check {
  const details = { languages: project.languages, sdks: project.sdks };
  if (project.sdks.length === 0) {
    if (project.languages.length === 0) {
      return check(
        "sdk",
        "warn",
        "No package.json, pyproject.toml, requirements.txt, Pipfile or go.mod here, so no haau3 SDK was found. The API also takes plain HTTP.",
        [{ command: SDK_FLOORS.node.install, description: `For ${LANGUAGE_NAME.node}. Python: ${SDK_FLOORS.python.install}. Go: ${SDK_FLOORS.go.install}.` }],
        details,
      );
    }
    return check(
      "sdk",
      "warn",
      `This project names no haau3 SDK. The API also takes plain HTTP.`,
      project.languages.map((language) => ({ command: SDK_FLOORS[language].install, description: `Add haau3's SDK for ${LANGUAGE_NAME[language]}.` })),
      details,
    );
  }
  const old = project.sdks.filter((sdk) => sdk.verdict === "below");
  const why = "the first version in which the key's mode picks the host";
  const risk = "An older one sends a test key to production, which refuses it.";
  if (old.length > 0) {
    const named = old.map((sdk) => `${sdk.package} ${sdk.installed ?? sdk.declared ?? ""} in ${sdk.manifest}`.replace(/ {2,}/g, " ")).join(", and ");
    return check(
      "sdk",
      "warn",
      `${named} is older than ${why} (${old.map((sdk) => sdk.floor).join(", ")}). ${risk}`,
      old.map((sdk) => ({ command: UPGRADE[sdk.language], description: `Upgrade ${sdk.package}, and require ${sdk.floor} or newer in ${sdk.manifest}.` })),
      details,
    );
  }
  const open = project.sdks.filter((sdk) => sdk.verdict === "allows-below");
  if (open.length > 0) {
    const named = open.map((sdk) => `${sdk.package} ${sdk.declared ?? ""} in ${sdk.manifest}`.replace(/ {2,}/g, " ")).join(", and ");
    return check(
      "sdk",
      "warn",
      `${named} also allows versions older than ${why} (${open.map((sdk) => sdk.floor).join(", ")}). ${risk} Raise its lower bound.`,
      [],
      details,
    );
  }
  const named = project.sdks
    .map((sdk) => {
      const where = sdk.installedAbove ? "installed in a folder above this one" : "installed";
      const version = sdk.installed ? `${sdk.installed}, ${where}` : sdk.declared ? sdk.declared : "with no version haau3 could read";
      return `${sdk.package} (${version}) in ${sdk.manifest}`;
    })
    .join(", and ");
  return check("sdk", "pass", `${named}.`, [], details);
}

// --- the key and near-misses ---------------------------------------------------------------------

/** What a key is, for a person: its mode and the environment it reaches. */
const KIND: Readonly<Record<KeyMode, string>> = {
  live: "a live key, for production",
  test: "a test key, for the Sandbox",
  older: "a key made before live and test keys, for production; it does not work in the Sandbox",
  unrecognized: "not a haau3 key: it does not start with haau3_sk_, so haau3 will not send it, since it may be another service's secret",
};

interface KeyFacts {
  mode: KeyMode;
  wellFormed: boolean;
  /** Something comes before haau3_sk_, such as a quote or "Bearer ". */
  notAlone: boolean;
  /** Only visible ASCII: a key that holds a line break or an invisible character cannot be sent. */
  visible: boolean;
  /** A haau3 key in visible ASCII: the only value doctor sends. */
  sendable: boolean;
}

function keyFacts(found: Found): KeyFacts {
  const value = found.value.trim();
  const at = value.indexOf("haau3_sk_");
  const key = at > 0 ? value.slice(at) : value;
  const mode = modeOf(key);
  const visible = /^[\x21-\x7e]+$/.test(key);
  return { mode, wellFormed: at === 0 && wellFormed(value), notAlone: at > 0, visible, sendable: mode !== "unrecognized" && visible };
}

function sandboxNamed(settings: Settings): boolean {
  return settings.environment?.value.trim().toLowerCase() === "sandbox";
}

const UNREADABLE: Readonly<Record<NonNullable<EnvFile["why"]>, string>> = {
  "not-a-file": "is not a file",
  "too-large": "is over 1 MiB, more than an env file holds",
  denied: "could not be read",
  "not-text": "is not UTF-8 text, as UTF-16 is not",
};

/** The files looked in, as a sentence lists them, with any that could not be read. */
function looked(files: EnvFile[]): string {
  const read = files.filter((file) => file.loaded);
  const names = ["the environment", ...read.map((file) => file.shown)];
  const listed = names.length > 2 ? `${names.slice(0, -1).join(", ")} or ${names.at(-1)}` : names.join(" or ");
  const missing = read.filter((file) => file.state !== "read");
  const notes = missing.map((file) => `${file.shown} ${file.state === "missing" ? "does not exist" : UNREADABLE[file.why ?? "denied"]}`);
  return `${listed}${notes.length ? ` (${notes.join("; ")})` : ""}`;
}

/** The variable a file's first line sets, when it sets one. */
function firstLineVariable(text: string | null): string | null {
  const first = text?.split(/\r?\n/, 1)[0] ?? "";
  const match = /^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]{0,63})[ \t]*=/.exec(first.slice(0, 200));
  return match ? match[1]! : null;
}

/** Whether a file has a line naming the key that Node's parser may not read: `NAME: value`, an odd `export`. */
function hasKeyLine(text: string | null): boolean {
  if (!text) return false;
  return text.split(/\r?\n|\r/).some((line) => line.length <= 500 && /^[ \t]*(?:export[ \t]+)?HAAU3_API_KEY[ \t]*[:=]/.test(line));
}

function keyCheck(settings: Settings, file: string | undefined, platform: NodeJS.Platform): Check {
  const found = settings.key;
  if (found) {
    const facts = keyFacts(found);
    const details = { status: "found", source: found.source, mode: facts.mode, wellFormed: facts.wellFormed };
    const head = `${KEY_VARIABLE} ${where(found)}: ${KIND[facts.mode]}`;
    if (facts.notAlone) return check("key", "warn", `${head}, with something before its haau3_sk_ prefix, such as a quote or "Bearer ". Set the key alone.`, [], details);
    if (facts.mode === "unrecognized") {
      const next = found.path === null ? [KEYS_CREATE_STEP] : [keysCreateStep({ replace: true, file: found.source === ".env.local" || found.source === ".env" ? undefined : found.source }, "Make a haau3 key and put it in place of this value.")];
      return check("key", "fail", `${head}.`, next, details);
    }
    if (!facts.visible) {
      return check("key", "fail", `${head}, holding a character that is not visible text, such as a line break or a zero-width space, so haau3 will not send it. Set the key alone, on one line.`, [], details);
    }
    if (!facts.wellFormed) {
      return check("key", "warn", `${head}, but not a haau3 key's whole shape: the prefix and 43 more characters. It may be cut short, or carry a quote or a space.`, [], details);
    }
    const file = settings.files.find((f) => f.path === found.path);
    if (file?.bom && firstLineVariable(file.text) === KEY_VARIABLE) {
      return check("key", "warn", `${head}. ${found.source} starts with a byte-order mark, so Node's --env-file and Vite skip that first line; Next.js reads it. Save the file as UTF-8 without the mark.`, [], details);
    }
    if (settings.unloadedKey) {
      return check("key", "warn", `${head}. ${settings.unloadedKey.source} also holds a key, which this project's loader does not read: only Next.js and Vite load it.`, [], details);
    }
    return check("key", "pass", `${head}.`, [], details);
  }
  const lookedIn = ["environment", ...settings.files.filter((f) => f.loaded).map((f) => f.shown)];
  if (sandboxNamed(settings)) {
    return check(
      "key",
      "pass",
      `No API key, and ${ENVIRONMENT_VARIABLE} ${where(settings.environment!)} names the Sandbox, which takes calls with no key at a small allowance an hour from each address. A free test key raises it.`,
      [],
      { status: "not-needed", environment: "sandbox", looked: lookedIn },
    );
  }
  const elsewhere =
    file === undefined
      ? ` A key written with keys create --file is in a file only your app loads: check it with npx haau3 doctor --file <file>.`
      : "";
  const emptyKey = settings.empty.find((e) => e.name === KEY_VARIABLE);
  const unread = settings.files.find((f) => f.loaded && f.variables && f.variables[KEY_VARIABLE] === undefined && hasKeyLine(f.text));
  const why = emptyKey
    ? `${KEY_VARIABLE} is set but empty ${where(emptyKey)}, which hides any value a later file gives it, as applications read them.`
    : settings.unloadedKey
      ? `${KEY_VARIABLE} is in ${settings.unloadedKey.source}, which this project's loader does not read: only Next.js and Vite load it. Move it to .env.`
      : unread
        ? `${unread.shown} has a ${KEY_VARIABLE} line that Node's parser does not read, though some loaders do. Write it as ${KEY_VARIABLE}=<key> on a line of its own.`
        : `${KEY_VARIABLE} is not set in ${looked(settings.files)}.`;
  return check(
    "key",
    "fail",
    `No API key: ${why}${elsewhere}`,
    [LOGIN_STEP, file === undefined ? KEYS_CREATE_STEP : keysCreateStep({ file }, KEYS_CREATE_STEP.description), sandboxStep(platform)],
    { status: "not-found", looked: lookedIn, ...(settings.unloadedKey ? { unloaded: settings.unloadedKey.source } : {}) },
  );
}

/** A name that can be printed: an ordinary variable name, and never a key. */
const PRINTABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const KEY_MARKER = /haau3_sk_/i;
/** Named as a haau3 key would be: HAAU3_TEST_API_KEY, HAAU3_LIVE_KEY. Not HAAU3_KEY_ID or a signing key. */
const KEY_LIKE_NAME = /^haau3_(?:[A-Za-z0-9_]{0,40}_)?(?:api_?key|(?:live|test)_?key)$/i;
const KEY_LIKE_VALUE = /haau3_sk_/i;
const NEAR_MISS_SHOWN = 20;

function nearMissCheck(settings: Settings, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): Check {
  const sources: { source: string; variables: NodeJS.Dict<string> }[] = [{ source: "environment", variables: env }];
  for (const file of settings.files) if (file.variables) sources.push({ source: file.shown, variables: file.variables });

  const hits: { name: string | null; source: string; by: "name" | "value" }[] = [];
  // A key alone on a line, which no parser reads as a variable.
  for (const file of settings.files) {
    if (file.text?.split(/\r?\n|\r/).some((line) => line.length <= 500 && /^[ \t]*["']?haau3_sk_[^=\s]*["']?[ \t]*$/i.test(line))) hits.push({ name: null, source: file.shown, by: "value" });
  }
  for (const { source, variables } of sources) {
    for (const [name, value] of Object.entries(variables)) {
      // The process environment's names do not differ by case on Windows, so there the SDK reads either.
      const isKeyVariable = source === "environment" && platform === "win32" ? name.toUpperCase() === KEY_VARIABLE : name === KEY_VARIABLE;
      if (isKeyVariable) continue;
      const by = typeof value === "string" && KEY_LIKE_VALUE.test(value) ? "value" : KEY_LIKE_NAME.test(name) || KEY_MARKER.test(name) ? "name" : null;
      if (!by) continue;
      hits.push({ name: PRINTABLE_NAME.test(name) && !KEY_MARKER.test(name) ? name : null, source, by });
    }
  }
  if (hits.length === 0) return check("near-miss", "pass", "No haau3 key is set under another name.", [], { variables: [] });

  const shown = hits.slice(0, NEAR_MISS_SHOWN);
  const first = shown[0]!;
  const what = first.name ? `${first.name} ${where(first)}` : `A variable ${where(first)}, whose name haau3 does not print,`;
  const holds = first.by === "value" ? (first.name ? "holds what looks like a haau3 key" : "holds what looks like a haau3 key") : "is named like a haau3 key";
  const more = hits.length > 1 ? `, and ${hits.length - 1} more variable${hits.length === 2 ? " does" : "s do"} the same` : "";
  const read = settings.key
    ? ` The SDK reads only ${KEY_VARIABLE}, so it is unused unless your own code reads it.`
    : first.by === "value"
      ? ` The SDK reads only ${KEY_VARIABLE}: rename it to ${KEY_VARIABLE}, or remove it.`
      : ` The SDK reads only ${KEY_VARIABLE}: if it is meant as the key, rename it.`;
  return check("near-miss", "warn", `${what} ${holds}${more}.${read}`, [], { variables: shown, count: hits.length });
}

// --- the env file --------------------------------------------------------------------------------

/** Every env file doctor read that holds a key: the one in use first, then any other a commit could carry. */
function filesHoldingKeys(settings: Settings): EnvFile[] {
  const holding = settings.files.filter(
    (f) => f.variables && Object.entries(f.variables).some(([name, value]) => (name === KEY_VARIABLE && value?.trim()) || (value !== undefined && KEY_LIKE_VALUE.test(value))),
  );
  const inUse = holding.find((f) => f.path === settings.key?.path);
  return inUse ? [inUse, ...holding.filter((f) => f !== inUse)] : holding;
}

async function envFileCheck(ctx: Context, settings: Settings, file: string | undefined): Promise<Check> {
  const holding = filesHoldingKeys(settings);
  if (holding.length === 0) {
    if (settings.key?.path === null) return check("env-file-ignored", "skip", "The key is in the environment, not in a file.", [], { file: null });
    if (sandboxNamed(settings)) return check("env-file-ignored", "skip", "No key is used, so no file holds one.", [], { file: null });
    return skip("env-file-ignored", "key", "no key was found.");
  }
  const answers = await Promise.all(holding.map(async (f) => ({ f, git: await gitAnswer(f.path, ctx.env, ctx.cwd) })));
  // The first file git would let a commit carry, else the file in use.
  const problem = answers.find((a) => a.git.kind === "not-ignored") ?? answers.find((a) => a.git.kind === "git-unavailable" || a.git.kind === "git-failed") ?? answers[0]!;
  const others = answers.filter((a) => a !== problem && a.git.kind !== "no-repository" && a.git.kind !== "ignored").length;
  const found = { path: problem.f.path, source: problem.f.shown };
  const shown = found.source;
  const git = problem.git;
  const details: Record<string, unknown> = { file: shown, git: git.kind, files: answers.map((a) => ({ file: a.f.shown, git: a.git.kind })) };
  void others;
  if (git.kind === "ignored") {
    const all = answers.map((a) => a.f.shown);
    return check("env-file-ignored", "pass", `git ignores ${all.length === 1 ? all[0] : `${all.slice(0, -1).join(", ")} and ${all.at(-1)}`}.`, [], details);
  }
  if (git.kind === "no-repository") {
    return check(
      "env-file-ignored",
      "skip",
      `${shown} is not in a git repository, so nothing could commit it. If you make one, add ${gitignoreLine(basename(found.path))} to its .gitignore first.`,
      [],
      details,
    );
  }
  if (git.kind === "git-unavailable") {
    return check("env-file-ignored", "warn", `${shown} is in a git repository and git could not be found on PATH, so haau3 could not check that git ignores it.`, [], details);
  }
  if (git.kind === "git-failed") {
    return check("env-file-ignored", "warn", `git could not say whether it ignores ${shown}. Run git status in that folder to see why.`, [], details);
  }
  const besideFile = shownPath(join(dirname(found.path), ".gitignore"), ctx.cwd);
  const gitignore = printablePath(besideFile) ? besideFile : join(dirname(shown), ".gitignore");
  const line = gitignoreLine(basename(found.path));
  details.gitignore = { file: gitignore, line };
  if (git.tracked) {
    return check(
      "env-file-ignored",
      "fail",
      `git tracks ${shown}, so the key is committed with it. Stop tracking it, add this line to ${gitignore}, and commit:\n  ${line}\nIf the file was ever pushed, revoke the key on the keys page and make a new one.`,
      [{ command: gitRmCached(shown), description: `Stop tracking ${shown}, keeping the file. Then add ${line} to ${gitignore} and commit.` }],
      details,
    );
  }
  return check(
    "env-file-ignored",
    "fail",
    `git does not ignore ${shown}, so the key could be committed. Add this line to ${gitignore}:\n  ${line}`,
    [{ ...doctorStep(file), description: `Check again after adding ${line} to ${gitignore}.` }],
    details,
  );
}

/** `git rm --cached` for a file, run in its own folder, so a file outside this repository can be named. */
function gitRmCached(shown: string): string {
  const folder = dirname(shown);
  const name = basename(shown);
  return folder === "." ? `git rm --cached -- ${arg(name)}` : `git -C ${arg(folder)} rm --cached -- ${arg(name)}`;
}

// --- settings: the SDK's client ------------------------------------------------------------------

interface ClientAttempt {
  check: Check;
  /** The project's client, when the SDK made one. */
  client: Haau3 | null;
  /** The SDK refused only because there is no key and the Sandbox is not named. */
  noKey: boolean;
  /** HAAU3_BASE_URL as checked, for a call with no key to the same place. */
  baseURL?: string | undefined;
}

/**
 * An address as doctor prints it: its origin, and `/…` when it has a path, which can carry a token of
 * a gateway's. haau3's own addresses have none.
 */
export function shownBase(address: string): string {
  const url = new URL(address);
  return url.pathname && url.pathname !== "/" ? `${url.origin}/…` : url.origin;
}

/** Whether the client calls its environment's own address: haau3's, not a stand-in's or a proxy's. */
function ownAddress(client: Haau3): boolean {
  return client.baseURL === ENVIRONMENT_ADDRESSES[client.environment];
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Where doctor sends a key: haau3's own two addresses, or this computer (owner, 2026-11-12). A base URL
 * can come from a committed env file, so a project someone else wrote could otherwise collect the key
 * from your shell; any other host is checked with no key.
 */
function keyMayGo(client: Haau3): boolean {
  const { origin, hostname } = new URL(client.baseURL);
  return origin === ENVIRONMENT_ADDRESSES.production || origin === ENVIRONMENT_ADDRESSES.sandbox || LOOPBACK.has(hostname);
}

function clientOptions(ctx: Context) {
  return { fetch: ctx.fetch, timeout: CALL_TIMEOUT_MS, maxRetries: 0, appInfo: { name: "haau3-cli", version: VERSION } };
}

/** The SDK's refusal of these settings, in doctor's words, naming each variable and where it is. */
function refusalMessage(code: string | undefined, settings: Settings): { message: string; next: NextStep[] } {
  const key = settings.key ? `${KEY_VARIABLE} ${where(settings.key)}` : KEY_VARIABLE;
  const environment = settings.environment ? `${ENVIRONMENT_VARIABLE} ${where(settings.environment)}` : ENVIRONMENT_VARIABLE;
  const base = settings.baseURL ? `${BASE_URL_VARIABLE} ${where(settings.baseURL)}` : BASE_URL_VARIABLE;
  const file = settings.key?.path ? settings.key.source : undefined;
  const sandboxCause = sandboxNamed(settings) ? `${environment} names the Sandbox` : `${base} is the Sandbox's address`;
  switch (code) {
    case "api-key-not-alone":
      return { message: `${key} has something before its haau3_sk_ prefix, such as quotes or "Bearer ". Set the key alone.`, next: [] };
    case "test-key-outside-sandbox":
      return {
        message: `${key} is a test key, which works only in the Sandbox, and ${environment} names production. Remove ${ENVIRONMENT_VARIABLE} to call the Sandbox with it, or use a live key.`,
        next: [keysCreateStep({ replace: true, file }, "Make a live key in place of the test key.")],
      };
    case "live-key-in-sandbox":
      return {
        message: `${key} is a live key, which does not work in the Sandbox, and ${sandboxCause}. Use a test key there.`,
        next: [keysCreateStep({ test: true, replace: true, file }, "Make a test key in place of the live key.")],
      };
    case "older-key-in-sandbox":
      return {
        message: `${key} was made before live and test keys, so it does not work in the Sandbox, and ${sandboxCause}. Use a test key there.`,
        next: [keysCreateStep({ test: true, replace: true, file }, "Make a test key in place of the older key.")],
      };
    case "invalid-environment":
      return { message: `${environment} is neither production nor sandbox.`, next: [] };
    case "invalid-base-url":
      return { message: `${base} is not an http or https address with a host.`, next: [] };
    case "environment-conflicts-with-base-url":
      return { message: `${environment} names one environment, and ${base} is the other's own address. Name one environment, or remove one of them.`, next: [] };
    default:
      return {
        message: `haau3 could not make the SDK's client${code ? ` (${code})` : ""}.`,
        next: [{ command: "npx haau3@latest --version", description: "Check for a newer version, then report it at https://github.com/haau3/haau3-cli/issues." }],
      };
  }
}

function settingsCheck(ctx: Context, settings: Settings): ClientAttempt {
  const details: Record<string, unknown> = {
    environment: settings.environment ? { source: settings.environment.source } : null,
    baseURL: settings.baseURL ? { source: settings.baseURL.source } : null,
  };
  const fail = (message: string, next: NextStep[] = []): ClientAttempt => ({ check: check("settings", "fail", message, next, details), client: null, noKey: false });

  // The command line's own rule for an address it is given, before the SDK's: https, or http on this
  // computer, with nothing that could be a credential in it. The key is never sent anywhere else.
  let baseURL: string | undefined;
  if (settings.baseURL) {
    const named = `${BASE_URL_VARIABLE} ${where(settings.baseURL)}`;
    const keyIn = (text: string) => KEY_MARKER.test(text) || (settings.key !== null && holdsKey(text, settings.key.value.trim()));
    const holdsAKey = () => fail(`${named} holds what looks like an API key, so haau3 will not use it. Remove it, and put the key in ${KEY_VARIABLE}.`);
    if (keyIn(settings.baseURL.value)) return holdsAKey();
    const checked = checkAddress(settings.baseURL.value);
    if (!checked.ok) return fail(`${named} ${checked.why}, so haau3 will not send a request there. Remove it to call the API at its own address.`);
    // Checked again as parsed: a URL's parser drops line breaks and tabs, which can split a key's marker.
    if (keyIn(checked.address)) return holdsAKey();
    baseURL = checked.address;
  }
  const named = settings.environment?.value.trim().toLowerCase();
  if (named !== undefined) (details.environment as Record<string, unknown>).value = named === "production" || named === "sandbox" ? named : null;

  let client: Haau3;
  try {
    client = new Haau3({
      // An empty key, never undefined, so the SDK reads no key of its own from the environment.
      apiKey: settings.key?.value ?? "",
      environment: named as Environment | undefined,
      baseURL,
      ...clientOptions(ctx),
    });
  } catch (error) {
    const code = error instanceof Haau3Error ? error.code : undefined;
    if (code === "no-api-key") return { check: skip("settings", "key", "with no key and the Sandbox not named, the SDK makes no client."), client: null, noKey: true, baseURL };
    const { message, next } = refusalMessage(code, settings);
    details.refused = code ?? null;
    return fail(message, next);
  }

  details.client = { environment: client.environment, baseURL: shownBase(client.baseURL) };
  const own = ENVIRONMENT_ADDRESSES[client.environment];
  if (settings.baseURL && client.baseURL !== own) {
    return {
      check: check("settings", "warn", `${BASE_URL_VARIABLE} ${where(settings.baseURL)} sends every call to ${shownBase(client.baseURL)}, not to ${NAMED[client.environment]}'s own address, ${own}.`, [], details),
      client,
      noKey: false,
      baseURL,
    };
  }
  const why = settings.baseURL
    ? `${BASE_URL_VARIABLE} ${where(settings.baseURL)} names its address`
    : settings.environment
      ? `${ENVIRONMENT_VARIABLE} ${where(settings.environment)} names it`
      : "the key's mode picks it";
  return { check: check("settings", "pass", `The SDK calls ${NAMED[client.environment]} at ${shownBase(client.baseURL)}: ${why}.`, [], details), client, noKey: false, baseURL };
}

// --- the calls -----------------------------------------------------------------------------------

/**
 * A request id as the API sends it, a UUID, or nothing: an answer from anything else could carry
 * whatever it was sent, the key included, in that header.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function safeRequestId(id: string | undefined): string | null {
  return id !== undefined && UUID.test(id) ? id : null;
}

/** A code the API names, as the command line repeats one: short, kebab-case, never a key. */
const CODE = /^[a-z][a-z0-9-]{0,63}$/;

/** The 403 codes doctor names in words; any other is in the details only. */
const KNOWN_403 = new Set(["test-key-outside-sandbox", "live-key-in-sandbox", "phi-agreement-required"]);

/** The longest wait doctor repeats from Retry-After: a day. A longer one is not believed. */
const MAX_RETRY_AFTER_S = 86_400;

/**
 * An answer's status, code and request id, in the shape every error of the command line carries.
 * Never its body, and never a code that holds any part of the key sent.
 */
function problemOf(error: unknown, key: string | null): Problem | undefined {
  if (!(error instanceof Haau3Error)) return undefined;
  const status = (error as { status?: unknown }).status;
  if (typeof status !== "number") return undefined;
  const problem: Problem = { type: "about:blank", title: `HTTP ${status}`, status };
  if (error instanceof ForbiddenError && error.code && CODE.test(error.code) && !(key && holdsKey(error.code, key))) problem.code = error.code;
  const requestId = safeRequestId(error.requestId);
  if (requestId) problem.requestId = requestId;
  return problem;
}

async function reachableCheck(client: Haau3, rerun: NextStep): Promise<Check> {
  const host = shownBase(client.baseURL);
  try {
    const answer = await client.request({ method: "GET", path: "/health", timeout: CALL_TIMEOUT_MS, maxRetries: 0 });
    const details = { host, status: answer.status, durationMs: answer.durationMs, requestId: safeRequestId(answer.requestId) };
    if (answer.status === 200) return check("reachable", "pass", `${host} answered in ${answer.durationMs} ms.`, [], details);
    if (answer.status === 429) return check("reachable", "warn", `${host} answered /health with 429: over a limit for now.`, [rerun], details);
    if (answer.status >= 500) return check("reachable", "fail", `${host} answered /health with ${answer.status}. ${COLD_START}`, [rerun], details);
    if (!ownAddress(client)) {
      // A stand-in made from the public spec has no /health; it answered, so metadata is still asked.
      return check("reachable", "warn", `${host} answered /health with ${answer.status}: it answers, but has no /health, as a stand-in may not.`, [], details);
    }
    return check("reachable", "fail", `${host} answered /health with ${answer.status}, so this may not be the haau3 API.`, [rerun], details);
  } catch (error) {
    if (error instanceof NoAnswerError) {
      const details = { host, reason: error.reason, detail: error.detail ?? null };
      if (error.reason === "network") {
        return check("reachable", "fail", `Could not reach ${host}${error.detail ? ` (${error.detail})` : ""}. Check the network, a proxy or a firewall.`, [rerun], details);
      }
      return check("reachable", "fail", `No answer from ${host} (${error.reason}). ${COLD_START}`, [rerun], details);
    }
    const name = error instanceof Error ? error.name : "an error";
    return check("reachable", "fail", `haau3 could not call ${host} (${name}).`, [rerun], { host });
  }
}

interface KeyWorksInput {
  client: Haau3;
  settings: Settings;
  /** The key's mode, when there is one. */
  mode: KeyMode | null;
  file: string | undefined;
  /** This run again, with the same --file. */
  rerun: NextStep;
}

async function keyWorksCheck({ client, settings, mode, file, rerun }: KeyWorksInput): Promise<Check> {
  const host = shownBase(client.baseURL);
  const withKey = settings.key !== null;
  const keyFile = settings.key?.path ? settings.key.source : file;
  const remake = (description: string) =>
    settings.key?.path === null
      ? { command: "npx haau3 keys create", description: `Make a key and write it to this project's env file. Then unset ${KEY_VARIABLE} in this shell, which applications read first.` }
      : keysCreateStep({ test: mode === "test", replace: true, file: keyFile }, description);
  try {
    const { durationMs, requestId } = await client.fhirMetadata({}, { timeout: CALL_TIMEOUT_MS, maxRetries: 0 }).withResponse();
    const details = { status: 200, durationMs, requestId: safeRequestId(requestId), withKey };
    if (!ownAddress(client)) {
      // Another address answered: it took the call, which proves nothing about the key at haau3.
      return check("key-works", "warn", `${host} answered metadata in ${durationMs} ms. It is not ${NAMED[client.environment]}'s own address, so the key is not proven at haau3.`, [], details);
    }
    if (!withKey) return check("key-works", "pass", `${sentence(NAMED[client.environment])} answered with no key, in ${durationMs} ms.`, [], details);
    return check("key-works", "pass", `The API took the key: ${NAMED[client.environment]} answered in ${durationMs} ms.`, [], details);
  } catch (error) {
    const problem = problemOf(error, settings.key?.value.trim() ?? null);
    const details: Record<string, unknown> = { withKey, problem: problem ?? null };
    if (error instanceof NoAnswerError) Object.assign(details, { reason: error.reason, detail: error.detail ?? null });
    if (error instanceof AuthError) {
      if (!withKey) return check("key-works", "fail", `${host} refused a call with no key (401).`, [LOGIN_STEP, KEYS_CREATE_STEP], details);
      return check("key-works", "fail", "The API did not take the key (401): it is not one the API knows, or it was revoked.", [remake("Make a new key in place of it.")], details);
    }
    if (error instanceof ForbiddenError) {
      const code = problem?.code;
      const why =
        code === "test-key-outside-sandbox"
          ? "it is a test key, at an address that takes live keys"
          : code === "live-key-in-sandbox"
            ? "it is a live key, at an address that takes test keys"
            : `the API refused it here${code && KNOWN_403.has(code) ? ` (${code})` : ""}`;
      const who = ownAddress(client) ? "The API" : host;
      const said = withKey ? `${who} took the key but refused the call (403)` : `${who} refused a call with no key (403)`;
      return check("key-works", "fail", `${said}: ${why}.`, [], details);
    }
    if (error instanceof NoAnswerError) {
      if (error.reason === "rate-limited") {
        const wait = error.retryAfter !== undefined && Number.isFinite(error.retryAfter) && error.retryAfter <= MAX_RETRY_AFTER_S ? error.retryAfter : undefined;
        const later = wait !== undefined ? ` It says to try again in ${wait} s.` : "";
        if (!withKey) {
          return check(
            "key-works",
            "warn",
            `Over the Sandbox's allowance for calls with no key from this address (429).${later} A free test key raises it.`,
            [keysCreateStep({ test: true }, "Make a free test key, which raises the limit.")],
            { ...details, retryAfter: wait ?? null },
          );
        }
        return check("key-works", "warn", `Over a limit (429), so the key was not proven.${later}`, [rerun], { ...details, retryAfter: wait ?? null });
      }
      if (error.reason === "unreadable") {
        return check("key-works", "fail", `${host} answered metadata with something that is not a FHIR CapabilityStatement, so it may not be the haau3 API.`, [], details);
      }
      if (error.reason === "network") {
        return check("key-works", "fail", `Could not reach ${host}${error.detail ? ` (${error.detail})` : ""}.`, [rerun], details);
      }
      return check("key-works", "fail", `No answer from ${host} (${error.reason}${error.status ? `, ${error.status}` : ""}). ${COLD_START}`, [rerun], details);
    }
    if (error instanceof RefusedError) {
      return check("key-works", "fail", `${host} refused the metadata read (${error.status}), so it may not be the haau3 API.`, [], details);
    }
    const name = error instanceof Error ? error.name : "an error";
    return check("key-works", "fail", `haau3 could not read metadata (${name}).`, [], details);
  }
}

// --- signed in -----------------------------------------------------------------------------------

/**
 * The stored session, read and never changed: when the two stores hold different ones, the one that
 * ends last. Reconciling them, which ends the other's grant, is for login, whoami and logout; doctor
 * asks nothing of the platform or the sign-in service.
 */
async function storedSession(ctx: Context, address: string) {
  const loaded = await ctx.store.load(address);
  const sessions = [loaded.record.session, loaded.other?.record.session].filter((s) => s !== undefined);
  const session = sessions.sort((a, b) => b.expiresAt - a.expiresAt)[0];
  const pending = loaded.record.pending ?? loaded.other?.record.pending;
  return { session, pending, keyringUnreachable: loaded.keyringUnreachable };
}

async function signedInCheck(ctx: Context, keyWorks: boolean, keyFound: boolean, key: string | null): Promise<Check> {
  const platform = resolvePlatform(ctx.env);
  if (!platform.ok) return check("signed-in", "warn", platform.error.message, platform.error.next);
  const { session, pending: waiting, keyringUnreachable } = await storedSession(ctx, platform.platformURL);
  const now = ctx.now();
  if (session && session.expiresAt > now) {
    // A name the platform gave is repeated only when it holds no part of the token or the key.
    const token = session.accessToken.reveal();
    const safe = (text: string | null) => (text === null || KEY_MARKER.test(text) || holdsSecret(text, token) || (key !== null && holdsKey(text, key)) ? null : text);
    const email = safe(session.member.email);
    const name = safe(session.organization.name);
    const who = email && name ? `${email} in ${name}` : (name ?? email);
    return check("signed-in", "pass", `Signed in${who ? ` as ${who}` : ""}, until ${when(session.expiresAt, now)}.`, [], {
      signedIn: true,
      organization: { id: safe(session.organization.id), name, slug: safe(session.organization.slug) },
      expiresAt: new Date(session.expiresAt).toISOString(),
    });
  }
  const details = { signedIn: false, keyringUnreachable };
  const unseen = keyringUnreachable ? " The system's credential store could not be reached, so a session kept there could not be checked." : "";
  const pending = waiting !== undefined && waiting.expiresAt > now;
  const state = pending ? "Not signed in yet: a sign-in is waiting for approval." : session ? `Not signed in: the session ended at ${when(session.expiresAt, now)}.` : "Not signed in.";
  if (keyWorks) return check("signed-in", "pass", `${state}${unseen} The key does not need a session: signing in is only for making keys.`, [], details);
  const next = pending ? [COMPLETE_STEP] : keyFound ? [] : [LOGIN_STEP];
  return check("signed-in", "warn", `${state}${unseen} Signing in lets haau3 make a key and write it to this project.`, next, details);
}

// --- the report ----------------------------------------------------------------------------------

/** Each command once, in the order the checks gave them. */
function steps(checks: Check[]): NextStep[] {
  const seen = new Set<string>();
  return checks.flatMap((c) => c.next).filter((step) => (seen.has(step.command) ? false : (seen.add(step.command), true)));
}

const STATUS_WIDTH = 4;
const NAME_WIDTH = Math.max(...CHECKS.map((name) => name.length));

function lineOf(c: Check): string {
  const indent = " ".repeat(2 + STATUS_WIDTH + 2 + NAME_WIDTH + 2);
  const [first, ...rest] = c.message.split("\n");
  return [`  ${c.status.padEnd(STATUS_WIDTH)}  ${c.name.padEnd(NAME_WIDTH)}  ${first}`, ...rest.map((line) => `${indent}${line}`)].join("\n");
}

function header(client: Haau3 | null): string {
  if (!client) return "Checked this project. No client could be made, so no environment was called with its settings.";
  return `Checked this project for ${NAMED[client.environment]}, at ${shownBase(client.baseURL)}.`;
}

export async function doctor(ctx: Context, options: DoctorOptions): Promise<Result> {
  if (options.file !== undefined) {
    const refused = fileFlagError(options.file, { command: "npx haau3 doctor", description: "Check the project's own env files instead." });
    if (refused) return misused(COMMAND, refused);
  }
  const platform = process.platform;
  const project = readProject(ctx.cwd);
  const settings = findSettings({ cwd: ctx.cwd, env: ctx.env, file: options.file });
  const keyMode = settings.key ? keyFacts(settings.key).mode : null;

  const checks: Check[] = [nodeCheck(project), sdkCheck(project)];
  const key = keyCheck(settings, options.file, platform);
  checks.push(key, nearMissCheck(settings, ctx.env, platform), await envFileCheck(ctx, settings, options.file));

  const sendable = settings.key === null || keyFacts(settings.key).sendable;
  const attempt: ClientAttempt = sendable
    ? settingsCheck(ctx, settings)
    : { check: skip("settings", "key", "haau3 will not send this value as it is."), client: null, noKey: false };
  // The key is kept from a host that is neither haau3's nor this computer: settings says so, /health is
  // asked with no key, and the key is not proven.
  const keyKept = attempt.client !== null && settings.key !== null && !keyMayGo(attempt.client);
  if (keyKept) {
    const named = `${BASE_URL_VARIABLE} ${where(settings.baseURL!)}`;
    attempt.check = check(
      "settings",
      "warn",
      `${named} sends every call to ${shownBase(attempt.client!.baseURL)}, which is neither haau3's own address nor this computer. haau3 sends a key only to those, so it checked that host with no key.`,
      [],
      { ...attempt.check.details, keySent: false },
    );
  }
  checks.push(attempt.check);

  // With no key, the network is still checked on the Sandbox, which needs none: unless production is
  // what the project names, which no call without a key can reach.
  const production = ENVIRONMENT_ADDRESSES.production;
  const namesProduction =
    settings.environment?.value.trim().toLowerCase() === "production" || (attempt.baseURL !== undefined && new URL(attempt.baseURL).origin === production);
  let probe = keyKept ? null : attempt.client;
  if (!probe && (keyKept || (attempt.noKey && !namesProduction))) {
    try {
      // To HAAU3_BASE_URL as checked, never the SDK's own read of the environment.
      probe = new Haau3({ apiKey: "", environment: "sandbox", baseURL: attempt.baseURL, ...clientOptions(ctx) });
    } catch {
      probe = null;
    }
  }
  const rerun = doctorStep(options.file);
  const reachable = probe
    ? await reachableCheck(probe, rerun)
    : !sendable || attempt.noKey
      ? skip("reachable", "key", attempt.noKey ? "production takes no call without a key." : "haau3 will not send this value as it is.")
      : skip("reachable", "settings", "the SDK made no client from these settings.");
  checks.push(reachable);

  // A host that answered /health with something else, as a stand-in may, is still asked for metadata.
  const answered = reachable.status === "pass" || (reachable.status === "warn" && reachable.details.status !== 429);
  let keyWorks: Check;
  if (!attempt.client) {
    keyWorks =
      attempt.noKey || !sendable
        ? skip("key-works", "key", attempt.noKey ? "no key was found, and the Sandbox is not named." : "haau3 will not send this value as it is.")
        : skip("key-works", "settings", "the SDK made no client from these settings.");
  } else if (keyKept) keyWorks = skip("key-works", "settings", "haau3 does not send the key to that host.");
  else if (!answered) keyWorks = skip("key-works", "reachable", reachable.status === "warn" ? "the API is over a limit for now." : "the API could not be reached.");
  else keyWorks = await keyWorksCheck({ client: attempt.client, settings, mode: keyMode, file: options.file, rerun });
  checks.push(keyWorks);

  checks.push(await signedInCheck(ctx, keyWorks.status === "pass" && settings.key !== null, settings.key !== null, settings.key?.value.trim() ?? null));

  const environment = attempt.client?.environment ?? null;
  const failed = checks.filter((c) => c.status === "fail");
  const warned = checks.filter((c) => c.status === "warn");
  const data = {
    ready: failed.length === 0,
    environment,
    baseURL: attempt.client ? shownBase(attempt.client.baseURL) : null,
    checks,
    next: steps([...failed, ...warned]),
  };

  const lines = [header(attempt.client), "", ...checks.map(lineOf), ""];
  if (failed.length === 0) {
    const summary = warned.length === 0 ? "Ready." : `Ready, with ${warned.length} warning${warned.length === 1 ? "" : "s"}.`;
    lines.push(summary);
    const next = steps(warned);
    if (next.length) lines.push("", "Next:", ...next.map((step) => `  ${step.command}\n    ${step.description}`));
    return { document: success(COMMAND, data, environment), text: `${lines.join("\n")}\n`, exit: EXIT.ok };
  }
  // At a terminal the failed checks' steps go to stderr with the error; the warnings' are here.
  const failedCommands = new Set(steps(failed).map((step) => step.command));
  const alsoNext = steps(warned).filter((step) => !failedCommands.has(step.command));
  if (alsoNext.length) lines.push("For the warnings:", ...alsoNext.map((step) => `  ${step.command}\n    ${step.description}`), "");
  const names = failed.map((c) => c.name).join(", ");
  const error = {
    code: "not-ready",
    message: `Not ready: ${failed.length} check${failed.length === 1 ? "" : "s"} failed (${names}).`,
    next: steps(failed),
  };
  return { document: failure(COMMAND, error, environment, data), text: `${lines.join("\n")}\n`, exit: EXIT.failed };
}
