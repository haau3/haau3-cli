// git is asked by a full path found on PATH, never by its bare name and never from the current folder
// or a relative PATH entry, so a project that ships a program named git can never have it run. A
// planted git writes a marker if it ever runs; the marker must stay absent.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findGit, gitAnswer } from "../src/git.js";

let project: string;
let marker: string;
beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), "cli-git-"));
  marker = join(project, "planted-git-ran");
});
afterEach(() => rmSync(project, { recursive: true, force: true }));

/** Where this computer's real git is, from PATH, for a PATH that holds it after the planted one. */
function realGitFolder(): string {
  const found = findGit(process.env, project);
  if (!found) throw new Error("these tests need git on PATH");
  return dirname(found);
}

/** A program named git that leaves a marker when it runs. */
function plantGit(folder: string): void {
  mkdirSync(folder, { recursive: true });
  if (process.platform === "win32") {
    // Not a working program, but Windows would try to start it, and that alone is the failure.
    writeFileSync(join(folder, "git.exe"), "planted");
    return;
  }
  writeFileSync(join(folder, "git"), `#!/bin/sh\ntouch "${marker}"\nexit 0\n`);
  chmodSync(join(folder, "git"), 0o755);
}

const env = (path: string): NodeJS.ProcessEnv => ({ ...process.env, PATH: path, Path: path });

describe("finding git", () => {
  it("skips the current folder, relative entries and empty ones", () => {
    plantGit(project);
    plantGit(join(project, "bin"));
    const real = realGitFolder();
    const path = [project, "bin", "", ".", real].join(delimiter);
    const found = findGit(env(path), project);
    expect(found).not.toBeNull();
    expect(dirname(found!)).toBe(real);
  });

  it("finds nothing when PATH holds no git", () => {
    expect(findGit(env(""), project)).toBeNull();
    plantGit(project);
    expect(findGit(env(project), project)).toBeNull();
  });
});

describe("asking git", () => {
  it("never runs a git planted in the project, and asks the real one", async () => {
    execFileSync("git", ["init", "-q"], { cwd: project });
    writeFileSync(join(project, ".gitignore"), ".env\n");
    plantGit(project);
    const path = [".", "", project, realGitFolder()].join(delimiter);
    expect(await gitAnswer(join(project, ".env"), env(path), project)).toEqual({ kind: "ignored" });
    expect(existsSync(marker)).toBe(false);
  });

  it("says when the repository has no git to ask, rather than guessing", async () => {
    execFileSync("git", ["init", "-q"], { cwd: project });
    plantGit(project);
    expect(await gitAnswer(join(project, ".env"), env(project), project)).toEqual({ kind: "git-unavailable" });
    expect(existsSync(marker)).toBe(false);
  });

  it("says no repository holds a file outside one, without running git", async () => {
    plantGit(project);
    expect(await gitAnswer(join(project, ".env"), env(project), project)).toEqual({ kind: "no-repository" });
  });

  it("tells ignored, not ignored and tracked apart", async () => {
    execFileSync("git", ["init", "-q"], { cwd: project });
    const path = env(process.env.PATH ?? process.env.Path ?? "");
    expect(await gitAnswer(join(project, ".env"), path, project)).toEqual({ kind: "not-ignored", tracked: false });
    writeFileSync(join(project, ".env"), "A=1\n");
    execFileSync("git", ["add", ".env"], { cwd: project });
    writeFileSync(join(project, ".gitignore"), ".env\n");
    expect(await gitAnswer(join(project, ".env"), path, project)).toEqual({ kind: "not-ignored", tracked: true });
    expect(await gitAnswer(join(project, ".env.local"), path, project)).toEqual({ kind: "not-ignored", tracked: false });
    writeFileSync(join(project, ".gitignore"), ".env*\n");
    expect(await gitAnswer(join(project, ".env.local"), path, project)).toEqual({ kind: "ignored" });
  });
});
