// Running a program a project's own tools are, such as git or its package manager. It is found by its
// full path on PATH, never by its bare name and never inside the project: Windows looks in the current
// folder before PATH, and `npx` puts node_modules/.bin first, so a bare name could run a program the
// project or a dependency ships under that name. It starts with no shell, except a Windows .cmd shim,
// which only cmd.exe can start; then the line holds the program's quoted path and arguments that are
// haau3's own constants, and nothing cmd.exe would expand.
import { spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { isAbsolute, join, posix, resolve, win32 } from "node:path";

/** The value of PATH, whatever its case: Windows spells it Path. */
export function pathOf(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  if (platform !== "win32") return env.PATH ?? "";
  const name = Object.keys(env).find((key) => key.toUpperCase() === "PATH");
  return name ? (env[name] ?? "") : "";
}

/** Whether `entry` is `folder` or inside it. */
export function within(entry: string, folder: string, platform: NodeJS.Platform): boolean {
  // path.relative compares without case on Windows, and across drives gives an absolute path.
  const rel = (platform === "win32" ? win32 : posix).relative(resolve(folder), resolve(entry));
  return !(rel.startsWith("..") || isAbsolute(rel));
}

/** A program found on PATH. */
export interface Program {
  /** Its full path. */
  path: string;
  /** A Windows .cmd shim, which cmd.exe has to start. */
  shim: boolean;
}

/**
 * A program's full path from PATH, or null. Skipped: an empty or relative entry, since both mean the
 * current folder; the current folder and anything inside it, which the project controls; and any
 * entry inside a node_modules folder, which `npx` and package scripts put first on PATH and any
 * dependency can fill. On Windows the names tried are the program's with each of `windows`, in order:
 * git only as git.exe, a package manager also as the .cmd shim npm, pnpm and yarn install.
 */
export function findProgram(
  name: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
  platform: NodeJS.Platform = process.platform,
  windows: readonly (".exe" | ".cmd")[] = [".exe"],
): Program | null {
  const separator = platform === "win32" ? ";" : ":";
  const names = platform === "win32" ? windows.map((extension) => `${name}${extension}`) : [name];
  for (const raw of pathOf(env, platform).split(separator)) {
    const entry = raw.trim().replace(/^"(.*)"$/, "$1");
    if (!entry || !isAbsolute(entry) || within(entry, cwd, platform)) continue;
    if (entry.split(/[\\/]/).some((part) => part.toLowerCase() === "node_modules")) continue;
    for (const file of names) {
      const candidate = join(entry, file);
      try {
        if (!statSync(candidate).isFile()) continue;
        if (platform !== "win32") accessSync(candidate, constants.X_OK);
        return { path: candidate, shim: file.toLowerCase().endsWith(".cmd") };
      } catch {
        // Not here, or not runnable: the next name, then the next entry.
      }
    }
  }
  return null;
}

/** An argument haau3 passes: one of its own constants, with nothing a shell or cmd.exe reads. */
const PLAIN_ARGUMENT = /^[A-Za-z0-9@/._:=-]+$/;

/** A path cmd.exe can be given in quotes: none of the characters it expands or ends a quote on. */
const QUOTABLE_PATH = /^[^"%^&|<>!\r\n]+$/;

export type RunResult =
  | { kind: "exited"; code: number }
  | { kind: "timed-out" }
  /** It could not be started: a path cmd.exe could not be given, or the system refused. */
  | { kind: "not-started" };

export interface RunOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  platform?: NodeJS.Platform;
  /** Where the program's own output goes, as it comes. Dropped when absent: it never enters a document. */
  output?: (text: string) => void;
}

/** The line cmd.exe runs for a shim, or null when the path is not one it can be given. */
export function shimLine(path: string, args: readonly string[]): string | null {
  if (!QUOTABLE_PATH.test(path)) return null;
  // `/s` takes the outer quotes off, and leaves the quoted path and the plain arguments.
  const quoted = `"${path}"`;
  return `"${[quoted, ...args].join(" ")}"`;
}

/** Runs a program in a folder and waits for it, for at most the time given. */
export function runProgram(program: Program, args: readonly string[], options: RunOptions): Promise<RunResult> {
  for (const value of args) {
    if (!PLAIN_ARGUMENT.test(value)) throw new Error("An argument to a program has to be one of haau3's own constants.");
  }
  const platform = options.platform ?? process.platform;
  let command = program.path;
  let argv: string[] = [...args];
  let verbatim = false;
  const env: NodeJS.ProcessEnv = { ...options.env };
  if (program.shim) {
    const line = shimLine(program.path, args);
    if (line === null) return Promise.resolve({ kind: "not-started" });
    command = `${options.env.SystemRoot ?? options.env.SYSTEMROOT ?? "C:\\Windows"}\\System32\\cmd.exe`;
    argv = ["/d", "/s", "/c", line];
    verbatim = true;
    // cmd.exe, and the shim it runs, then look for a bare program name on PATH only, never first in the project.
    env.NoDefaultCurrentDirectoryInExePath = "1";
  }
  return new Promise((resolveRun) => {
    let settled = false;
    const settle = (result: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveRun(result);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, argv, {
        cwd: options.cwd,
        env,
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments: verbatim,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      resolveRun({ kind: "not-started" });
      return;
    }
    const timer = setTimeout(() => {
      stop(child, platform, options.env);
      settle({ kind: "timed-out" });
    }, options.timeoutMs);
    const forward = (chunk: Buffer) => options.output?.(chunk.toString("utf8"));
    child.stdout?.on("data", forward);
    child.stderr?.on("data", forward);
    child.once("error", () => settle({ kind: "not-started" }));
    // Ended by a signal with no code of its own: a failure all the same.
    child.once("close", (code) => settle({ kind: "exited", code: code ?? 1 }));
  });
}

/** Stops a program that ran out of time, and on Windows the programs a shim started under it. */
function stop(child: ReturnType<typeof spawn>, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): void {
  if (platform === "win32" && child.pid !== undefined) {
    try {
      const taskkill = `${env.SystemRoot ?? env.SYSTEMROOT ?? "C:\\Windows"}\\System32\\taskkill.exe`;
      spawn(taskkill, ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true, shell: false });
      return;
    } catch {
      // Then as on any other system.
    }
  }
  child.kill();
}
