// Where the command line reads the settings the SDK takes, the way the project's own loader finds
// them: the process environment first, then the env files that loader reads, in the folder the command
// runs in, or one env file named instead. Next.js loads .env.local over .env; Node's loadEnvFile(),
// python-dotenv and godotenv read .env only, and Vite puts neither in process.env. The key, the
// environment and the base URL are each found this way, so doctor checks what the application will call.
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { printablePath, readsEnvLocal, shownPath } from "./envfile.js";
import { readSmallText } from "./files.js";

/** The env files read after the environment, in the order Next.js loads them: .env.local over .env. */
export const ENV_FILES = [".env.local", ".env"] as const;

export const KEY_VARIABLE = "HAAU3_API_KEY";
export const ENVIRONMENT_VARIABLE = "HAAU3_ENVIRONMENT";
export const BASE_URL_VARIABLE = "HAAU3_BASE_URL";

/** An env file bigger than this is not one, and is not read. */
const MAX_FILE_BYTES = 1024 * 1024;

/** The env files a project's own loader reads: both for Next.js, else .env alone. */
export function loadedFiles(cwd: string): readonly string[] {
  return readsEnvLocal(resolve(cwd)) ? ENV_FILES : [".env"];
}

/** One env file, as it was read. */
export interface EnvFile {
  /** The absolute path. */
  path: string;
  /** As it is printed: relative to the current folder when inside it. */
  shown: string;
  /** Whether the project's loader reads it: a .env.local outside Next.js is read only to warn. */
  loaded: boolean;
  /** Its variables, or null when it could not be read. */
  variables: NodeJS.Dict<string> | null;
  /** Its text, for the lines Node's parser does not read, or null when it could not be read. */
  text: string | null;
  /** Why there are no variables: it is not there, or it could not be read as an env file. */
  state: "read" | "missing" | "unreadable";
  /** Why it could not be read. */
  why?: "not-a-file" | "too-large" | "denied" | "not-text";
  /** It starts with a byte-order mark, whose first line Node's --env-file and Vite do not read. */
  bom: boolean;
}

/**
 * The env files to read: the one named; or those the project's loader reads, then .env.local even when
 * it does not, so a key there can be warned about. Each is read once.
 */
export function readEnvFiles({ cwd, file }: { cwd: string; file?: string | undefined }): EnvFile[] {
  const loaded = file === undefined ? loadedFiles(cwd) : [file];
  const names = file === undefined ? [...ENV_FILES] : [file];
  return names.map((name) => {
    const path = resolve(cwd, name);
    // The --file argument itself, already checked, when the path as printed is not plain.
    const printed = file === undefined ? name : shownPath(path, cwd);
    const shown = printablePath(printed) ? printed : name;
    return { path, shown, loaded: loaded.includes(name), ...readFile(path) };
  });
}

function readFile(path: string): Pick<EnvFile, "variables" | "text" | "state" | "why" | "bom"> {
  const read = readSmallText(path, MAX_FILE_BYTES);
  if (read.state === "missing") return { variables: null, text: null, state: "missing", bom: false };
  if (read.state === "unreadable") return { variables: null, text: null, state: "unreadable", why: read.why, bom: false };
  const bom = read.text.startsWith("\uFEFF");
  // Read as keys create reads it, the mark set aside; the key check says which loaders skip that line.
  const text = bom ? read.text.slice(1) : read.text;
  try {
    // Node's own parser, the one behind --env-file and loadEnvFile().
    return { variables: parseEnv(text), text, state: "read", bom };
  } catch {
    return { variables: null, text: null, state: "unreadable", why: "not-text", bom };
  }
}

/** A value found, and where: `environment`, or an env file as it is printed. */
export interface Found {
  value: string;
  source: string;
  /** The env file's absolute path, or null for the environment. */
  path: string | null;
}

/**
 * Where a variable is defined first: the environment, else the first file that sets it, whatever its
 * value. Node's --env-file and loadEnvFile(), Next.js and dotenv leave a variable that is already set,
 * even to nothing, so an empty one hides every later file's (measured with Node 24 and @next/env 16.4).
 */
function defined(name: string, env: NodeJS.ProcessEnv, files: EnvFile[]): Found | null {
  const fromEnvironment = env[name];
  if (fromEnvironment !== undefined) return { value: fromEnvironment, source: "environment", path: null };
  for (const file of files.filter((f) => f.loaded)) {
    const value = file.variables?.[name];
    if (value !== undefined) return { value, source: file.shown, path: file.path };
  }
  return null;
}

/**
 * A variable's value where the application finds it, or null when there is none. The SDK reads an
 * empty value as unset, and a key that is only spaces too, since it trims a key; an environment or a
 * base URL that is only spaces it refuses, so that is kept for the check that says so.
 */
export function lookup(name: string, env: NodeJS.ProcessEnv, files: EnvFile[]): Found | null {
  const found = defined(name, env, files);
  if (!found) return null;
  const empty = name === KEY_VARIABLE ? found.value.trim() === "" : found.value === "";
  return empty ? null : found;
}

/** The three settings, each where the application would find it. */
export interface Settings {
  files: EnvFile[];
  key: Found | null;
  environment: Found | null;
  baseURL: Found | null;
  /** Variables set to nothing where they are first defined, which hides any later file's value. */
  empty: (Found & { name: string })[];
  /** A key in a .env.local the project's loader does not read. */
  unloadedKey: Found | null;
}

export function findSettings({ cwd, env, file }: { cwd: string; env: NodeJS.ProcessEnv; file?: string | undefined }): Settings {
  const files = readEnvFiles({ cwd, file });
  const empty: Settings["empty"] = [];
  const read = (name: string) => {
    const found = lookup(name, env, files);
    const first = defined(name, env, files);
    if (!found && first) empty.push({ ...first, name });
    return found;
  };
  const unloaded = files.find((f) => !f.loaded && f.variables?.[KEY_VARIABLE]?.trim());
  const unloadedKey = unloaded ? { value: unloaded.variables![KEY_VARIABLE]!, source: unloaded.shown, path: unloaded.path } : null;
  return { files, key: read(KEY_VARIABLE), environment: read(ENVIRONMENT_VARIABLE), baseURL: read(BASE_URL_VARIABLE), empty, unloadedKey };
}

/** Where a found value is, as a sentence names it: "in the environment", "in .env.local". */
export function where(found: Pick<Found, "source">): string {
  return found.source === "environment" ? "in the environment" : `in ${found.source}`;
}
