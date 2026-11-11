// The session store's first choice: the operating system's own credential store (the macOS Keychain,
// Windows Credential Manager, or a Secret Service keyring on Linux), through @napi-rs/keyring. It is
// loaded only when a command needs it, so a computer where it cannot load falls back to the file.
// Every call is bounded: a store that waits on a prompt nobody will answer, as a keychain can inside
// an agent's sandbox, counts as unreachable after a few seconds.
import type { StoredRecord } from "./record.js";
import { isRecord } from "../signin/http.js";

/** The keyring entries' service name. Each platform address is an account under it. */
export const KEYRING_SERVICE = "haau3";

const TIMEOUT_MS = 5_000;

type KeyringModule = typeof import("@napi-rs/keyring");

let loading: Promise<KeyringModule | null> | undefined;

function loadKeyring(): Promise<KeyringModule | null> {
  loading ??= import("@napi-rs/keyring").then(
    (module) => module,
    () => null,
  );
  return loading;
}

/** Whether a call outlived its bound, so the process may have to be ended once it has printed. */
let stuck = false;

export function keyringCallStuck(): boolean {
  return stuck;
}

/** What the store is called where the command line says which one it used. */
export function keyringName(platform: NodeJS.Platform = process.platform): string {
  if (platform === "darwin") return "the macOS Keychain";
  if (platform === "win32") return "Windows Credential Manager";
  return "the Secret Service keyring";
}

export interface Keyring {
  read(address: string): Promise<StoredRecord | null>;
  write(address: string, record: StoredRecord): Promise<void>;
  remove(address: string): Promise<void>;
}

/** The OS store. Every method throws when the store cannot be reached, which the caller reads as fall back. */
export function osKeyring(service: string = KEYRING_SERVICE, timeoutMs: number = TIMEOUT_MS): Keyring {
  async function entry(address: string) {
    const keyring = await loadKeyring();
    if (!keyring) throw new Error("The credential store's module did not load.");
    // On Linux, only the Secret Service: never the kernel keyring, which forgets everything at reboot.
    return new keyring.AsyncEntry(service, address, { linux: { store: "secret-service" } });
  }
  return {
    async read(address) {
      const value = await bounded((signal) => entry(address).then((e) => e.getPassword(signal)), timeoutMs);
      if (value === null || value === undefined) return null;
      const parsed = JSON.parse(value) as unknown;
      return isRecord(parsed) ? (parsed as StoredRecord) : null;
    },
    async write(address, record) {
      await bounded((signal) => entry(address).then((e) => e.setPassword(JSON.stringify(record), signal)), timeoutMs);
    },
    async remove(address) {
      await bounded((signal) => entry(address).then((e) => e.deleteCredential(signal)), timeoutMs);
    },
  };
}

/** The call, given an abort signal, and a timer beside it in case the store ignores the signal. */
async function bounded<T>(run: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      stuck = true;
      controller.abort();
      reject(new Error("The credential store did not answer in time."));
    }, timeoutMs);
  });
  try {
    return await Promise.race([run(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
