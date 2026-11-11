// The session store's fallback: a file only the user can read, where GitHub's command line keeps its
// own. HAAU3_CONFIG_DIR, else $XDG_CONFIG_HOME/haau3, else %APPDATA%\haau3 on Windows, else
// ~/.config/haau3. The folder is made 0700 and the file written 0600, through a new file renamed into
// place, so a reader never sees half a file. On Windows the folder sits in the user's own profile,
// whose permissions already keep other users out.
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { isRecord } from "../signin/http.js";
import type { StoredRecord } from "./record.js";

export const CONFIG_DIR_VARIABLE = "HAAU3_CONFIG_DIR";
export const SESSION_FILE = "session.json";

const MAX_FILE_BYTES = 1024 * 1024;

/** The folder haau3 keeps its file in, by the rules above. */
export function configDir(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform, home: string = homedir()): string {
  const own = env[CONFIG_DIR_VARIABLE]?.trim();
  if (own) return own;
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
    const temporary = join(this.#dir, `.${SESSION_FILE}.${randomBytes(6).toString("hex")}.tmp`);
    try {
      writeFileSync(temporary, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      renameSync(temporary, this.path);
    } catch (error) {
      rmSync(temporary, { force: true });
      throw error;
    }
  }
}

function empty(): SessionFile {
  return { version: 1, records: {} };
}
