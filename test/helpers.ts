// Runs the command line two ways: in this process with fake streams, and as a real Node process
// started on the source through tsx, whose stdout is a pipe as an agent's is.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { main, type Io } from "../src/main.js";

export interface Captured {
  code: number | null;
  stdout: string;
  stderr: string;
}

export async function runCli(
  args: string[],
  { tty = false, env = {}, cwd = process.cwd() }: { tty?: boolean; env?: NodeJS.ProcessEnv; cwd?: string } = {},
): Promise<Captured> {
  let stdout = "";
  let stderr = "";
  const io: Io = {
    stdout: { isTTY: tty, write: (text: string) => (stdout += text) },
    stderr: { write: (text: string) => (stderr += text) },
    env,
    cwd,
  };
  const code = await main(args, io);
  return { code, stdout, stderr };
}

const TSX = fileURLToPath(new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url));
const ENTRY = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

/** The parent's environment without anything the command line reads, plus `env`. */
export function cleanEnv(env: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const kept = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(HAAU3_|CODEX_)/.test(name)));
  return { ...kept, ...env };
}

export function spawnCli(args: string[], { env = {}, cwd = process.cwd() }: { env?: NodeJS.ProcessEnv; cwd?: string } = {}): Captured {
  const result = spawnSync(process.execPath, [TSX, ENTRY, ...args], { cwd, env: cleanEnv(env), encoding: "utf8" });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}
