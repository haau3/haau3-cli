// Which package manager a project installs with, from its own files: how far up it looks, and what
// counts as the project's answer.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectManager, managerFor } from "../src/packages.js";

let outer: string;
beforeEach(() => {
  outer = mkdtempSync(join(tmpdir(), "cli-packages-"));
});
afterEach(() => rmSync(outer, { recursive: true, force: true }));

function write(path: string, text = ""): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}

describe("how far up it looks", () => {
  it("stops at the home folder, so a lockfile above it is not the project's", () => {
    const home = join(outer, "home");
    const project = join(home, "app");
    write(join(outer, "pnpm-lock.yaml"));
    write(join(project, "package.json"), "{}");
    expect(detectManager({ language: "node", cwd: project, env: {}, home })).toMatchObject({ ok: true, found: { manager: "npm", how: "default" } });
  });

  it("stops at a repository's top folder", () => {
    write(join(outer, "yarn.lock"));
    write(join(outer, "repo", ".git", "HEAD"));
    write(join(outer, "repo", "app", "package.json"), "{}");
    const found = detectManager({ language: "node", cwd: join(outer, "repo", "app"), env: { npm_config_user_agent: "bun/1.2.0" }, home: join(outer, "nowhere") });
    expect(found).toMatchObject({ ok: true, found: { manager: "bun", how: "ran-init" } });
  });

  it("takes a uv workspace's lock from the folder above, and the project's own Pipfile first", () => {
    write(join(outer, ".git", "HEAD"));
    write(join(outer, "uv.lock"));
    write(join(outer, "svc", "pyproject.toml"), '[project]\nname = "svc"\n');
    expect(detectManager({ language: "python", cwd: join(outer, "svc"), env: {}, home: join(outer, "nowhere") })).toMatchObject({ ok: true, found: { manager: "uv", how: "lockfile" } });
    write(join(outer, "svc", "Pipfile"), "[packages]\n");
    expect(detectManager({ language: "python", cwd: join(outer, "svc"), env: {}, home: join(outer, "nowhere") })).toMatchObject({ ok: true, found: { manager: "pipenv", how: "project-file" } });
  });

  it("reports two tools a project's files both name", () => {
    write(join(outer, "pyproject.toml"), "[tool.poetry]\nname = 'a'\n\n[tool.uv]\ndev-dependencies = []\n");
    expect(detectManager({ language: "python", cwd: outer, env: {}, home: join(outer, "nowhere") })).toMatchObject({ ok: false, candidates: ["poetry", "uv"] });
  });
});

describe("--package-manager", () => {
  it("takes only a manager the language has", () => {
    expect(managerFor("node", "pnpm")).toBe("pnpm");
    expect(managerFor("python", "pnpm")).toBeNull();
    expect(managerFor("go", "go")).toBe("go");
    expect(managerFor("node", "__proto__")).toBeNull();
  });
});
