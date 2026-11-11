// Whether git would leave a file out of a commit, asked of git itself, so every .gitignore, the
// repository's info/exclude and the user's global excludes count. A file git already tracks counts as
// not ignored: .gitignore does not stop a tracked file from being committed.
//
// git is run by a full path this code finds on PATH, never by its bare name and never from the current
// folder: Windows looks in the current folder before PATH, so a bare name could run a program the
// project ships as git.exe. Nothing goes through a shell, and fsmonitor is switched off, since a
// repository's own settings could otherwise name a program for git to run.
import { execFile } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

/** How long one question to git may take. */
export const GIT_TIMEOUT_MS = 5_000;

export type GitAnswer =
  /** No repository holds the file, so there is nothing to commit it to. */
  | { kind: "no-repository" }
  | { kind: "ignored" }
  | { kind: "not-ignored"; tracked: boolean }
  /** A repository holds the file, and there is no git on PATH to ask. */
  | { kind: "git-unavailable" }
  /** git was asked and gave no answer it could stand behind. */
  | { kind: "git-failed" };

/** The value of PATH, whatever its case: Windows spells it Path. */
function pathOf(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  if (platform !== "win32") return env.PATH ?? "";
  const name = Object.keys(env).find((key) => key.toUpperCase() === "PATH");
  return name ? (env[name] ?? "") : "";
}

export function sameFolder(a: string, b: string, platform: NodeJS.Platform): boolean {
  const [x, y] = [resolve(a), resolve(b)];
  return platform === "win32" ? x.toLowerCase() === y.toLowerCase() : x === y;
}

/**
 * git's full path from PATH, or null. An empty or relative entry is skipped, since both mean the
 * current folder, and so is the current folder itself. On Windows only git.exe counts: a .cmd or .bat
 * would need a shell.
 */
export function findGit(env: NodeJS.ProcessEnv, cwd: string, platform: NodeJS.Platform = process.platform): string | null {
  const separator = platform === "win32" ? ";" : ":";
  const name = platform === "win32" ? "git.exe" : "git";
  for (const raw of pathOf(env, platform).split(separator)) {
    const entry = raw.trim().replace(/^"(.*)"$/, "$1");
    if (!entry || !isAbsolute(entry) || sameFolder(entry, cwd, platform)) continue;
    const candidate = join(entry, name);
    try {
      if (!statSync(candidate).isFile()) continue;
      if (platform !== "win32") accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not here, or not runnable: the next entry.
    }
  }
  return null;
}

/**
 * Whether a folder, or one above it, holds a repository: a `.git` folder or file, as git itself looks.
 * GIT_DIR set in the environment counts too, since git then uses it wherever the command runs.
 */
export function inRepository(folder: string, env: NodeJS.ProcessEnv): boolean {
  if (env.GIT_DIR?.trim()) return true;
  let at = resolve(folder);
  for (;;) {
    try {
      statSync(join(at, ".git"));
      return true;
    } catch {
      // Not here: one folder up.
    }
    const up = dirname(at);
    if (up === at) return false;
    at = up;
  }
}

interface Ran {
  code: number | null;
  stdout: string;
}

function runGit(git: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<Ran> {
  return new Promise((done) => {
    try {
      execFile(
        git,
        ["-c", "core.fsmonitor=false", ...args],
        { cwd, env: { ...env, GIT_TERMINAL_PROMPT: "0" }, timeout: GIT_TIMEOUT_MS, windowsHide: true, shell: false, maxBuffer: 64 * 1024 },
        (error, stdout) => {
          const code = error ? (typeof error.code === "number" ? error.code : null) : 0;
          done({ code, stdout: String(stdout) });
        },
      );
    } catch {
      done({ code: null, stdout: "" });
    }
  });
}

/** What git says about one file: whether a repository holds it, and if so whether it is ignored. */
export async function gitAnswer(file: string, env: NodeJS.ProcessEnv, cwd: string, platform: NodeJS.Platform = process.platform): Promise<GitAnswer> {
  const folder = dirname(resolve(cwd, file));
  if (!inRepository(folder, env)) return { kind: "no-repository" };
  const git = findGit(env, cwd, platform);
  if (!git) return { kind: "git-unavailable" };

  // git may decline the repository (another user's, past a ceiling): then it cannot vouch for the file.
  const inside = await runGit(git, ["rev-parse", "--is-inside-work-tree"], folder, env);
  if (inside.code !== 0 || inside.stdout.trim() !== "true") return { kind: "git-failed" };

  const name = basename(file);
  const ignored = await runGit(git, ["check-ignore", "-q", "--", name], folder, env);
  if (ignored.code === 0) return { kind: "ignored" };
  if (ignored.code !== 1) return { kind: "git-failed" };

  const tracked = await runGit(git, ["ls-files", "--error-unmatch", "--", name], folder, env);
  return { kind: "not-ignored", tracked: tracked.code === 0 };
}
