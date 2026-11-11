// git is asked by a full path found on PATH, never by its bare name and never from the current folder
// or a relative PATH entry, so a project that ships a program named git can never have it run. A
// planted git writes a marker if it ever runs; the marker must stay absent.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

  it("skips a git anywhere inside the project, and any in node_modules, where npx puts its bins first", () => {
    const modules = join(project, "node_modules", ".bin");
    const elsewhere = mkdtempSync(join(tmpdir(), "cli-git-modules-"));
    try {
      const outsideModules = join(elsewhere, "node_modules", ".bin");
      for (const folder of [modules, join(project, "tools"), outsideModules]) plantGit(folder);
      const real = realGitFolder();
      const found = findGit(env([modules, join(project, "tools"), outsideModules, real].join(delimiter)), project);
      expect(dirname(found!)).toBe(real);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
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

  it("is not misled by a GIT_DIR inherited from a hook, which would make git read the wrong index", async () => {
    execFileSync("git", ["init", "-q"], { cwd: project });
    mkdirSync(join(project, "app"));
    writeFileSync(join(project, "app", ".env"), "A=1\n");
    execFileSync("git", ["add", join("app", ".env")], { cwd: project });
    writeFileSync(join(project, ".gitignore"), ".env\n");
    const inherited = { ...env(process.env.PATH ?? process.env.Path ?? ""), GIT_DIR: join(project, ".git"), GIT_WORK_TREE: join(project, "app") };
    expect(await gitAnswer(join(project, "app", ".env"), inherited, project)).toEqual({ kind: "not-ignored", tracked: true });
  });

  it.skipIf(process.platform === "linux")("asks about the file by the name the disk has, whatever case it was typed in", async () => {
    execFileSync("git", ["init", "-q"], { cwd: project });
    writeFileSync(join(project, "Prod.env"), "A=1\n");
    execFileSync("git", ["add", "Prod.env"], { cwd: project });
    writeFileSync(join(project, ".gitignore"), "*.env\n");
    const path = env(process.env.PATH ?? process.env.Path ?? "");
    expect(await gitAnswer(join(project, "prod.env"), path, project)).toEqual({ kind: "not-ignored", tracked: true });
  });

  it.skipIf(process.platform === "win32")("finds the repository a linked folder really leads into", async () => {
    const repo = join(project, "repo");
    mkdirSync(join(repo, "app"), { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: repo });
    symlinkSync(join(repo, "app"), join(project, "alias"));
    const path = env(process.env.PATH ?? "");
    expect(await gitAnswer(join(project, "alias", ".env"), path, project)).toEqual({ kind: "not-ignored", tracked: false });
  });
});
