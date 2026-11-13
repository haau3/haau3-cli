// Runs the command line two ways: in this process with fake streams, and as a real Node process
// started on the source through tsx, whose stdout is a pipe as an agent's is. Neither touches the
// computer's own credential store: in-process runs are given a store, and real processes keep the
// session in a file under a folder the test names.
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { main, type Io } from "../src/main.js";
import { AGENT_MARKERS } from "../src/output.js";
import type { Keyring } from "../src/session/keyring.js";
import type { StoredRecord } from "../src/session/record.js";
import { sessionStore, type SessionStore } from "../src/session/store.js";

export interface Captured {
  code: number | null;
  stdout: string;
  stderr: string;
}

export type Extra = Partial<Pick<Io, "stdin" | "now" | "sleep" | "store" | "enter" | "openBrowser" | "fetch" | "ask" | "confirm">>;

export async function runCli(
  args: string[],
  { tty = false, env = {}, cwd = process.cwd(), io = {} }: { tty?: boolean; env?: NodeJS.ProcessEnv; cwd?: string; io?: Extra } = {},
): Promise<Captured> {
  let stdout = "";
  let stderr = "";
  const full: Io = {
    stdout: { isTTY: tty, write: (text: string) => (stdout += text) },
    stderr: { write: (text: string) => (stderr += text) },
    env,
    cwd,
    ...io,
  };
  const code = await main(args, full);
  return { code, stdout, stderr };
}

const TSX = fileURLToPath(new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url));
const ENTRY = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

/**
 * The parent's environment without anything the command line reads, plus `env`. CI is dropped too:
 * CI services set it, and `keys revoke` refuses where it is set, so a test of a person at a terminal
 * would pass on a laptop and fail in CI. A test of CI sets it itself.
 */
export function cleanEnv(env: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const markers = new Set<string>(AGENT_MARKERS);
  const kept = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(HAAU3_|CODEX_)/.test(name) && !markers.has(name) && name !== "CI"));
  return { ...kept, ...env };
}

export function spawnCli(args: string[], { env = {}, cwd = process.cwd() }: { env?: NodeJS.ProcessEnv; cwd?: string } = {}): Captured {
  const result = spawnSync(process.execPath, [TSX, ENTRY, ...args], { cwd, env: cleanEnv(env), encoding: "utf8" });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** As spawnCli, without blocking this process, so a stand-in server in it can answer. */
export function spawnCliAsync(args: string[], { env = {}, cwd = process.cwd() }: { env?: NodeJS.ProcessEnv; cwd?: string } = {}): Promise<Captured> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [TSX, ENTRY, ...args], { cwd, env: cleanEnv(env) });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

/** A credential store in memory, with what it holds open to the test. */
export function memoryKeyring(): Keyring & { entries: Map<string, string> } {
  const entries = new Map<string, string>();
  return {
    entries,
    async read(address) {
      const value = entries.get(address);
      return value === undefined ? null : (JSON.parse(value) as StoredRecord);
    },
    async write(address, record) {
      entries.set(address, JSON.stringify(record));
    },
    async remove(address) {
      entries.delete(address);
    },
  };
}

/** A credential store that cannot be reached, as inside a sandbox that blocks it. */
export function unreachableKeyring(): Keyring & { calls: number } {
  const keyring = {
    calls: 0,
    async read(): Promise<StoredRecord | null> {
      keyring.calls++;
      throw new Error("blocked");
    },
    async write(): Promise<void> {
      keyring.calls++;
      throw new Error("blocked");
    },
    async remove(): Promise<void> {
      keyring.calls++;
      throw new Error("blocked");
    },
  };
  return keyring;
}

/** A clock that starts now and moves only when the command line sleeps, so no test waits. */
export function fakeClock(start = Date.now()): { now(): number; sleep(ms: number): Promise<void>; slept: number[] } {
  let at = start;
  const slept: number[] = [];
  return {
    slept,
    now: () => at,
    sleep: async (ms) => {
      slept.push(ms);
      at += ms;
    },
  };
}

/** A store for one test: the given credential store first, then a file in `dir`. */
export function testStore(dir: string, keyring: Keyring, env: NodeJS.ProcessEnv = {}): SessionStore {
  return sessionStore({ env: { ...env, HAAU3_CONFIG_DIR: dir }, keyring });
}
