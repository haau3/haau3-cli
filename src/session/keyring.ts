// The session store's first choice: the operating system's own credential store (the macOS Keychain,
// Windows Credential Manager, or a Secret Service keyring on Linux), through @napi-rs/keyring.
//
// Each call runs in a short-lived child process, killed when it outlives its bound. The package's
// calls run on Node's thread pool, where an abort cannot stop a call already running, and a process
// waits for that pool before it ends: so a keychain waiting on a prompt nobody will answer, as one can
// inside an agent's sandbox, would hold the command open however its promise was settled. A process
// can be killed. After one call fails or times out, the store counts as unreachable for the rest of
// the run, and the file takes over. The secret goes to the child on stdin and comes back on stdout,
// never as an argument.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isRecord } from "../signin/http.js";
import type { StoredRecord } from "./record.js";

/** The keyring entries' service name. Each platform address is an account under it. */
export const KEYRING_SERVICE = "haau3";

const TIMEOUT_MS = 5_000;

/** Windows Credential Manager holds at most 2,560 bytes a credential; a bigger record goes to the file. */
const MAX_RECORD_BYTES = 2_400;

/** What the child runs: one call, its input on stdin, its answer on stdout. Resolved from this module's folder. */
const HELPER = `
import { createRequire } from "node:module";
let input = "";
for await (const chunk of process.stdin) input += chunk;
let answer;
try {
  const { op, service, account, value } = JSON.parse(input);
  const { Entry } = createRequire(process.argv[1])("@napi-rs/keyring");
  const entry = new Entry(service, account, { linux: { store: "secret-service" } });
  if (op === "read") answer = { ok: true, value: entry.getPassword() ?? null };
  else if (op === "write") answer = { ok: true, value: entry.setPassword(value) ?? null };
  else answer = { ok: true, value: entry.deleteCredential() };
} catch {
  answer = { ok: false };
}
process.stdout.write(JSON.stringify(answer));
`;

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
  let unreachable = false;
  async function run(op: "read" | "write" | "remove", account: string, value?: string): Promise<unknown> {
    if (unreachable) throw new Error("The credential store could not be reached earlier in this run.");
    try {
      return await helper({ op, service, account, value }, timeoutMs);
    } catch (error) {
      unreachable = true;
      throw error;
    }
  }
  return {
    async read(address) {
      const value = await run("read", address);
      if (typeof value !== "string") return null;
      const parsed = JSON.parse(value) as unknown;
      return isRecord(parsed) ? (parsed as StoredRecord) : null;
    },
    async write(address, record) {
      const value = JSON.stringify(record);
      if (Buffer.byteLength(value) > MAX_RECORD_BYTES) throw new Error("Too big for every credential store to hold.");
      await run("write", address, value);
    },
    async remove(address) {
      await run("remove", address);
    },
  };
}

function helper(input: { op: string; service: string; account: string; value?: string }, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", HELPER, fileURLToPath(import.meta.url)], {
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
    let output = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("The credential store did not answer in time."));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
    child.on("error", () => {
      clearTimeout(timer);
      reject(new Error("The credential store's helper did not start."));
    });
    child.on("close", () => {
      clearTimeout(timer);
      try {
        const answer = JSON.parse(output) as unknown;
        if (isRecord(answer) && answer.ok === true) resolve(answer.value);
        else reject(new Error("The credential store refused."));
      } catch {
        reject(new Error("The credential store's helper gave no answer."));
      }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(input));
  });
}
