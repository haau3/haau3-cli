// The session store's fallback: a file only the user can read, where GitHub's command line keeps its
// own. An absolute HAAU3_CONFIG_DIR, else an absolute $XDG_CONFIG_HOME/haau3, else %APPDATA%\haau3 on
// Windows, else ~/.config/haau3. The folder is made 0700 and the file written 0600, through a new file
// renamed into place, so a reader never sees half a file. On Windows the folder sits in the user's own
// profile, whose permissions already keep other users out.
//
// What the file says is trusted only when nobody else could have written it: on Linux and macOS a file
// that is not a regular file of the user's own, mode 0600 or tighter, in a folder of the user's own
// that nobody else can write, is not read, and such a folder is not written to.
import { randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { isRecord } from "../signin/http.js";
import type { StoredRecord } from "./record.js";

export const CONFIG_DIR_VARIABLE = "HAAU3_CONFIG_DIR";
export const SESSION_FILE = "session.json";

const MAX_FILE_BYTES = 1024 * 1024;

/** A temporary file left by a run that was killed between writing and renaming is removed after this. */
const STALE_TEMPORARY_MS = 60_000;

/** The folder haau3 keeps its file in, by the rules above. A relative path in either variable is ignored. */
export function configDir(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform, home: string = homedir()): string {
  const own = env[CONFIG_DIR_VARIABLE]?.trim();
  if (own && isAbsolute(own)) return own;
  const xdg = env.XDG_CONFIG_HOME?.trim();
  if (xdg && isAbsolute(xdg)) return join(xdg, "haau3");
  const appData = env.APPDATA?.trim();
  if (platform === "win32" && appData) return join(appData, "haau3");
  return join(home, ".config", "haau3");
}

interface SessionFile {
  version: 1;
  /** One record per platform address. */
  records: Record<string, StoredRecord>;
}

/** Whether only the user could have written this folder, on systems with owners and modes. */
function folderIsOwn(dir: string): boolean {
  if (process.platform === "win32" || typeof process.getuid !== "function") return true;
  try {
    const stat = lstatSync(dir);
    return stat.isDirectory() && stat.uid === process.getuid() && (stat.mode & 0o022) === 0;
  } catch {
    return false;
  }
}

/** Whether this is a regular file of the user's own that nobody else can read or write. */
function fileIsOwn(path: string): boolean {
  if (process.platform === "win32" || typeof process.getuid !== "function") return true;
  const stat = lstatSync(path);
  return stat.isFile() && stat.uid === process.getuid() && (stat.mode & 0o077) === 0;
}

export class FileStore {
  readonly path: string;
  readonly #dir: string;

  constructor(dir: string) {
    this.#dir = dir;
    this.path = join(dir, SESSION_FILE);
  }

  read(address: string): StoredRecord | null {
    return this.#load().records[address] ?? null;
  }

  write(address: string, record: StoredRecord): void {
    const file = this.#load();
    file.records[address] = record;
    this.#save(file);
  }

  remove(address: string): void {
    const file = this.#load();
    if (!(address in file.records)) return;
    delete file.records[address];
    if (Object.keys(file.records).length === 0) rmSync(this.path, { force: true });
    else this.#save(file);
  }

  #load(): SessionFile {
    let raw: string;
    try {
      if (!folderIsOwn(this.#dir) || !fileIsOwn(this.path)) return empty();
      if (statSync(this.path).size > MAX_FILE_BYTES) return empty();
      raw = readFileSync(this.path, "utf8");
    } catch {
      return empty();
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (isRecord(parsed) && parsed.version === 1 && isRecord(parsed.records)) {
        return { version: 1, records: parsed.records as Record<string, StoredRecord> };
      }
    } catch {
      // A file that is not ours, or half of one: start again rather than fail.
    }
    return empty();
  }

  #save(file: SessionFile): void {
    mkdirSync(this.#dir, { recursive: true, mode: 0o700 });
    if (!folderIsOwn(this.#dir)) throw new Error("The folder is not the user's own, or others can write to it.");
    this.#sweep();
    const temporary = join(this.#dir, `.${SESSION_FILE}.${randomBytes(6).toString("hex")}.tmp`);
    try {
      writeFileSync(temporary, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      renameSync(temporary, this.path);
    } catch (error) {
      rmSync(temporary, { force: true });
      throw error;
    }
  }

  /** Removes temporary files a killed run left, which hold a session too. */
  #sweep(): void {
    try {
      for (const name of readdirSync(this.#dir)) {
        if (!name.startsWith(`.${SESSION_FILE}.`) || !name.endsWith(".tmp")) continue;
        const path = join(this.#dir, name);
        if (Date.now() - lstatSync(path).mtimeMs > STALE_TEMPORARY_MS) rmSync(path, { force: true });
      }
    } catch {
      // Nothing to sweep, or nothing that can be.
    }
  }
}

function empty(): SessionFile {
  return { version: 1, records: {} };
}
