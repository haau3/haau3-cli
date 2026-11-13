// Running a program a project's own tools are, such as git or its package manager. It is found by its
// full path on PATH, never by its bare name and never inside the project: Windows looks in the current
// folder before PATH, and `npx` puts node_modules/.bin first, so a bare name could run a program the
// project or a dependency ships under that name. It starts with no shell, except a Windows .cmd shim,
// which only cmd.exe can start; then the line holds the program's quoted path and arguments that are
// haau3's own constants, and nothing cmd.exe would expand.
import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, posix, resolve, sep, win32 } from "node:path";

/** The value of PATH, whatever its case: Windows spells it Path. */
export function pathOf(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  if (platform !== "win32") return env.PATH ?? "";
  const name = Object.keys(env).find((key) => key.toUpperCase() === "PATH");
  return name ? (env[name] ?? "") : "";
}

/** A path as the disk has it, through any link: the path itself when it does not exist. */
function real(path: string): string {
  try {
    return realpathSync.native(resolve(path));
  } catch {
    return resolve(path);
  }
}

/**
 * Whether `entry` is `folder` or inside it, by their real paths, so a link or another spelling of the
 * project is still the project. Without case on Windows and macOS, whose disks usually ignore it.
 */
export function within(entry: string, folder: string, platform: NodeJS.Platform): boolean {
  const fold = (path: string) => (platform === "win32" || platform === "darwin" ? path.toLowerCase() : path);
  const rel = (platform === "win32" ? win32 : posix).relative(fold(real(folder)), fold(real(entry)));
  const separator = platform === "win32" ? "\\" : sep;
  return !(rel === ".." || rel.startsWith(`..${separator}`) || rel.startsWith("../") || isAbsolute(rel));
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
 * current folder; the current folder and anything inside it, which the project controls; any entry
 * inside a node_modules folder, which `npx` and package scripts put first on PATH and any dependency
 * can fill; and the folder Yarn 2 and later put first for a script, BERRY_BIN_FOLDER, which holds a
 * launcher for every program the project's dependencies ship. On Windows the names tried are the
 * program's with each of `windows`, in order: git only as git.exe, a package manager also as the
 * .cmd shim npm, pnpm and yarn install.
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
  const berry = env.BERRY_BIN_FOLDER?.trim();
  for (const raw of pathOf(env, platform).split(separator)) {
    const entry = raw.trim().replace(/^"(.*)"$/, "$1");
    if (!entry || !isAbsolute(entry) || within(entry, cwd, platform)) continue;
    if (entry.split(/[\\/]/).some((part) => part.toLowerCase() === "node_modules")) continue;
    if (berry && within(entry, berry, platform)) continue;
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

/** A value that holds an API key, which no program haau3 runs is given. */
const KEY_MARKER = /haau3_sk_/i;

/** How long a stopped program has to end before it is killed outright, and then before haau3 stops waiting. */
const GRACE_MS = 3_000;

export type RunResult =
  | { kind: "exited"; code: number }
  /** It ran out of time and was stopped, with every program it started. */
  | { kind: "timed-out" }
  /**
   * It could not be started: a path cmd.exe could not be given, a network folder cmd.exe cannot
   * start in, or the system refused.
   */
  | { kind: "not-started"; why: "path" | "network-folder" | "refused" };

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

/** The environment a program runs with: the caller's, less any variable that holds an API key. */
export function childEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([, value]) => value === undefined || !KEY_MARKER.test(value)));
}

function systemRoot(env: NodeJS.ProcessEnv): string {
  return env.SystemRoot ?? env.SYSTEMROOT ?? "C:\\Windows";
}

/**
 * Runs a program in a folder and waits for it, for at most the time given. At the limit it stops the
 * program and every program it started (its process group, or its tree on Windows), and waits for
 * them to end, so nothing is still writing when the caller looks. Stopping haau3 stops them too.
 */
export function runProgram(program: Program, args: readonly string[], options: RunOptions): Promise<RunResult> {
  for (const value of args) {
    if (!PLAIN_ARGUMENT.test(value)) throw new Error("An argument to a program has to be one of haau3's own constants.");
  }
  const platform = options.platform ?? process.platform;
  let command = program.path;
  let argv: string[] = [...args];
  let verbatim = false;
  const env = childEnv(options.env);
  if (program.shim) {
    // cmd.exe cannot start in a network folder: it would start in the Windows folder instead.
    if (options.cwd.startsWith("\\\\")) return Promise.resolve({ kind: "not-started", why: "network-folder" });
    const line = shimLine(program.path, args);
    if (line === null) return Promise.resolve({ kind: "not-started", why: "path" });
    command = `${systemRoot(options.env)}\\System32\\cmd.exe`;
    argv = ["/d", "/s", "/c", line];
    verbatim = true;
    // cmd.exe, and the shim it runs, then look for a bare program name on PATH only, never first in the project.
    env.NoDefaultCurrentDirectoryInExePath = "1";
  }
  return new Promise((resolveRun) => {
    let child: ChildProcess;
    try {
      child = spawn(command, argv, {
        cwd: options.cwd,
        env,
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments: verbatim,
        // Its own process group on POSIX, so stopping it reaches every program it starts.
        detached: platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      resolveRun({ kind: "not-started", why: "refused" });
      return;
    }
    let result: RunResult | null = null;
    let finished = false;
    const timers: NodeJS.Timeout[] = [];
    const forward = (chunk: Buffer) => options.output?.(chunk.toString("utf8"));
    child.stdout?.on("data", forward);
    child.stderr?.on("data", forward);

    const onSignal = (signal: NodeJS.Signals) => {
      stopTree(child, platform, options.env, "SIGTERM");
      cleanup();
      process.kill(process.pid, signal);
    };
    const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
    for (const signal of signals) process.once(signal, onSignal);
    const cleanup = () => {
      for (const signal of signals) process.removeListener(signal, onSignal);
      for (const timer of timers) clearTimeout(timer);
    };
    const finish = (outcome: RunResult) => {
      if (finished) return;
      finished = true;
      cleanup();
      resolveRun(result ?? outcome);
    };

    timers.push(
      setTimeout(() => {
        result = { kind: "timed-out" };
        stopTree(child, platform, options.env, "SIGTERM");
        timers.push(setTimeout(() => stopTree(child, platform, options.env, "SIGKILL"), GRACE_MS));
        // Should even a kill not end it, haau3 stops waiting and lets it go, holding nothing open.
        timers.push(
          setTimeout(() => {
            child.stdout?.destroy();
            child.stderr?.destroy();
            child.unref();
            finish({ kind: "timed-out" });
          }, 2 * GRACE_MS),
        );
      }, options.timeoutMs),
    );
    child.once("error", () => finish({ kind: "not-started", why: "refused" }));
    // Ended by a signal with no code of its own: a failure all the same.
    child.once("close", (code) => finish({ kind: "exited", code: code ?? 1 }));
  });
}

/** Stops a program and every program it started: its process group on POSIX, its tree on Windows. */
function stopTree(child: ChildProcess, platform: NodeJS.Platform, env: NodeJS.ProcessEnv, signal: "SIGTERM" | "SIGKILL"): void {
  if (child.pid === undefined) return;
  if (platform === "win32") {
    try {
      const taskkill = spawn(`${systemRoot(env)}\\System32\\taskkill.exe`, ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true, shell: false });
      // No taskkill: the program itself, at least.
      taskkill.once("error", () => child.kill(signal));
    } catch {
      child.kill(signal);
    }
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}
