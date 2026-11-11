// Whether git would leave a file out of a commit, asked of git itself, so every .gitignore, the
// repository's info/exclude and the user's global excludes count. A file git already tracks counts as
// not ignored: .gitignore does not stop a tracked file from being committed.
//
// git is run by a full path this code finds on PATH, never by its bare name and never from inside the
// project: Windows looks in the current folder before PATH, and `npx` puts node_modules/.bin first, so
// a bare name could run a program the project or a dependency ships as git. Nothing goes through a
// shell, and git gets no GIT_ variable from the caller, no fsmonitor and no lazy fetch, since a
// repository's own settings could otherwise name a program for git to run.
import { execFile } from "node:child_process";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, posix, resolve, win32 } from "node:path";

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

/** Whether `entry` is `folder` or inside it. */
function within(entry: string, folder: string, platform: NodeJS.Platform): boolean {
  // path.relative compares without case on Windows, and across drives gives an absolute path.
  const rel = (platform === "win32" ? win32 : posix).relative(resolve(folder), resolve(entry));
  return !(rel.startsWith("..") || isAbsolute(rel));
}

/**
 * git's full path from PATH, or null. Skipped: an empty or relative entry, since both mean the current
 * folder; the current folder and anything inside it, which the project controls; and any entry inside
 * a node_modules folder, which `npx` and package scripts put first on PATH and any dependency can
 * fill. On Windows only git.exe counts: a .cmd or .bat would need a shell.
 */
export function findGit(env: NodeJS.ProcessEnv, cwd: string, platform: NodeJS.Platform = process.platform): string | null {
  const separator = platform === "win32" ? ";" : ":";
  const name = platform === "win32" ? "git.exe" : "git";
  for (const raw of pathOf(env, platform).split(separator)) {
    const entry = raw.trim().replace(/^"(.*)"$/, "$1");
    if (!entry || !isAbsolute(entry) || within(entry, cwd, platform)) continue;
    if (entry.split(/[\\/]/).some((part) => part.toLowerCase() === "node_modules")) continue;
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

/**
 * The environment git runs with: the caller's, without any GIT_ variable, so git finds the repository
 * from the file's own folder as it would at a prompt. A git hook, or `git rebase -x`, exports GIT_DIR,
 * which would make git read the wrong index. No prompt, and no lazy fetch: a repository's own settings
 * could otherwise name a program for git to run to fetch an object it lacks.
 */
function gitEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const kept = Object.fromEntries(Object.entries(env).filter(([name]) => !name.toUpperCase().startsWith("GIT_")));
  return { ...kept, GIT_TERMINAL_PROMPT: "0", GIT_NO_LAZY_FETCH: "1" };
}

function runGit(git: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<Ran> {
  return new Promise((done) => {
    try {
      execFile(
        git,
        ["-c", "core.fsmonitor=false", ...args],
        { cwd, env: gitEnv(env), timeout: GIT_TIMEOUT_MS, windowsHide: true, shell: false, maxBuffer: 64 * 1024 },
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

/** A file's folder and name as the disk has them: the file's own when it exists, else its folder's and the name given. */
function onDisk(path: string): [string, string] {
  try {
    const real = realpathSync.native(path);
    return [dirname(real), basename(real)];
  } catch {
    try {
      return [realpathSync.native(dirname(path)), basename(path)];
    } catch {
      return [dirname(path), basename(path)];
    }
  }
}

/** What git says about one file: whether a repository holds it, and if so whether it is ignored. */
export async function gitAnswer(file: string, env: NodeJS.ProcessEnv, cwd: string, platform: NodeJS.Platform = process.platform): Promise<GitAnswer> {
  // The folder and the name as they are on disk: through any link in the path, so the repository is
  // the one the file is really in, and in the disk's own case, since git's index compares names
  // exactly while macOS and Windows disks do not (`Prod.env` tracked, `prod.env` asked about).
  const [folder, name] = onDisk(resolve(cwd, file));
  if (!inRepository(folder, env)) return { kind: "no-repository" };
  const git = findGit(env, cwd, platform);
  if (!git) return { kind: "git-unavailable" };

  // git may decline the repository (another user's, past a ceiling): then it cannot vouch for the file.
  const inside = await runGit(git, ["rev-parse", "--is-inside-work-tree"], folder, env);
  if (inside.code !== 0 || inside.stdout.trim() !== "true") return { kind: "git-failed" };

  const ignored = await runGit(git, ["check-ignore", "-q", "--", name], folder, env);
  if (ignored.code === 0) return { kind: "ignored" };
  if (ignored.code !== 1) return { kind: "git-failed" };

  const tracked = await runGit(git, ["ls-files", "--error-unmatch", "--", name], folder, env);
  return { kind: "not-ignored", tracked: tracked.code === 0 };
}
