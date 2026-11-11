// Where a session is kept, and the one place that decides it: the operating system's credential store
// first, and a file only the user can read when that store cannot be reached. HAAU3_SESSION_STORE=file
// goes straight to the file, for containers, CI and sandboxes that block the credential store. Each
// command that keeps something says which store took it.
//
// Both stores are read every time, since a run in a sandbox can have written to the file while the
// credential store held another session. The commands reconcile the two (src/commands/session.ts), so
// no session is ever deleted without its grant being ended.
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

export interface Found {
  record: SessionRecord;
  where: Where;
}

export interface Loaded {
  /** The record in use: the credential store's, else the file's. Empty when neither holds one. */
  record: SessionRecord;
  /** Where that record was found, or null when there is none. */
  where: Where | null;
  /** The file's record, when the credential store holds one too: two copies to reconcile. */
  other: Found | null;
  /** The credential store was to be read and could not be. Never true when HAAU3_SESSION_STORE=file. */
  keyringUnreachable: boolean;
  /** HAAU3_SESSION_STORE=file: the credential store was not looked at, by request. */
  fileOnly: boolean;
}

export interface Cleared {
  /** Whether a copy may be left in a store that could not be reached or would not delete it. */
  incomplete: boolean;
}

export interface SessionStore {
  /** The fallback file's path, which an error names when nothing would keep the session. */
  readonly filePath: string;
  load(address: string): Promise<Loaded>;
  /** Keeps the record, or clears it when it is empty. Null when neither store would take it. */
  save(address: string, record: SessionRecord): Promise<Where | null>;
  /** Clears the address's record from both stores, and says whether a copy may be left. */
  clear(address: string): Promise<Cleared>;
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

  function fromFile(address: string): SessionRecord | null {
    try {
      const stored = file.read(address);
      if (!stored) return null;
      const record = fromStored(stored, address);
      return isEmpty(record) ? null : record;
    } catch {
      return null;
    }
  }

  async function clear(address: string): Promise<Cleared> {
    let incomplete = false;
    if (!fileOnly) {
      try {
        // Deleted only when there is something to delete: asking a keychain to delete what it does not
        // hold can raise a prompt.
        if (await keyring.read(address)) await keyring.remove(address);
      } catch {
        incomplete = true;
      }
    }
    try {
      file.remove(address);
    } catch {
      incomplete = true;
    }
    return { incomplete };
  }

  return {
    filePath: file.path,
    clear,

    async load(address) {
      const fromTheFile = fromFile(address);
      if (fileOnly) {
        return { record: fromTheFile ?? {}, where: fromTheFile ? inFile("asked") : null, other: null, keyringUnreachable: false, fileOnly };
      }
      let stored;
      try {
        stored = await keyring.read(address);
      } catch {
        return { record: fromTheFile ?? {}, where: fromTheFile ? inFile("unreachable") : null, other: null, keyringUnreachable: true, fileOnly };
      }
      const fromTheKeyring = stored ? fromStored(stored, address) : null;
      if (fromTheKeyring && !isEmpty(fromTheKeyring)) {
        return { record: fromTheKeyring, where: inKeyring, other: fromTheFile ? { record: fromTheFile, where: inFile(null) } : null, keyringUnreachable: false, fileOnly };
      }
      return { record: fromTheFile ?? {}, where: fromTheFile ? inFile(null) : null, other: null, keyringUnreachable: false, fileOnly };
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
          // The file's copy was reconciled into this record before it was saved, so it can go.
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
