// Where a session is kept, and the one place that decides it: the operating system's credential store
// first, and a file only the user can read when that store cannot be reached. HAAU3_SESSION_STORE=file
// goes straight to the file, for containers, CI and sandboxes that block the credential store. Each
// command that keeps something says which store took it.
import { FileStore, configDir } from "./file.js";
import { keyringName, osKeyring, type Keyring } from "./keyring.js";
import { fromStored, isEmpty, toStored, type SessionRecord } from "./record.js";

export const STORE_VARIABLE = "HAAU3_SESSION_STORE";

export interface Where {
  kind: "keyring" | "file";
  /** Its name, for a person: "the macOS Keychain", "a file only you can read". */
  name: string;
  /** The file's path, when it is the file. */
  path: string | null;
  /** Why the file: the credential store could not be reached, or HAAU3_SESSION_STORE asked for it. */
  reason: "unreachable" | "asked" | null;
}

export interface Loaded {
  record: SessionRecord;
  /** Where the record was found, or null when there is none. */
  where: Where | null;
}

export interface SessionStore {
  /** The fallback file's path, which an error names when nothing would keep the session. */
  readonly filePath: string;
  load(address: string): Promise<Loaded>;
  /** Keeps the record, or clears it when it is empty. Null when neither store would take it. */
  save(address: string, record: SessionRecord): Promise<Where | null>;
  /** Clears the address's record from both stores. */
  clear(address: string): Promise<void>;
}

export interface StoreOptions {
  env: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
  keyring?: Keyring;
}

export function sessionStore({ env, platform = process.platform, home, keyring = osKeyring() }: StoreOptions): SessionStore {
  const file = new FileStore(configDir(env, platform, home));
  const fileOnly = env[STORE_VARIABLE]?.trim().toLowerCase() === "file";
  const inKeyring: Where = { kind: "keyring", name: keyringName(platform), path: null, reason: null };
  const inFile = (reason: Where["reason"]): Where => ({ kind: "file", name: "a file only you can read", path: file.path, reason });

  function fromFile(address: string, reason: Where["reason"]): Loaded {
    try {
      const stored = file.read(address);
      return stored ? { record: fromStored(stored, address), where: inFile(reason) } : { record: {}, where: null };
    } catch {
      return { record: {}, where: null };
    }
  }

  async function clear(address: string): Promise<void> {
    if (!fileOnly) {
      try {
        // Deleted only when there is something to delete: asking a keychain to delete what it does not
        // hold can raise a prompt.
        if (await keyring.read(address)) await keyring.remove(address);
      } catch {
        // Out of reach. Whatever it holds ends with its token, which logout revokes.
      }
    }
    try {
      file.remove(address);
    } catch {
      // Nothing to remove, or a file that cannot be written; the next save replaces it.
    }
  }

  return {
    filePath: file.path,
    clear,

    async load(address) {
      if (fileOnly) return fromFile(address, "asked");
      try {
        const stored = await keyring.read(address);
        if (stored) return { record: fromStored(stored, address), where: inKeyring };
        return fromFile(address, null);
      } catch {
        return fromFile(address, "unreachable");
      }
    },

    async save(address, record) {
      if (isEmpty(record)) {
        await clear(address);
        return null;
      }
      const stored = toStored(record);
      if (!fileOnly) {
        try {
          await keyring.write(address, stored);
          // A copy the file kept while the credential store was out of reach is no longer the session.
          try {
            file.remove(address);
          } catch {
            // Left for the next clear.
          }
          return inKeyring;
        } catch {
          // Out of reach: the file takes it.
        }
      }
      try {
        file.write(address, stored);
        return inFile(fileOnly ? "asked" : "unreachable");
      } catch {
        return null;
      }
    },
  };
}
