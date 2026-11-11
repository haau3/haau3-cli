// The package npm publishes, and release-please's rules for versioning it.
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { VERSION } from "../src/version.js";

const read = (name: string) => readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
const config = JSON.parse(read("release-please-config.json")) as Record<string, any>;
const manifest = JSON.parse(read(".release-please-manifest.json")) as Record<string, string>;
const pkg = JSON.parse(read("package.json")) as Record<string, any>;

describe("the package", () => {
  it("is the bare name haau3, whose one executable is haau3", () => {
    expect(pkg.name).toBe("haau3");
    expect(pkg.bin).toEqual({ haau3: "dist/cli.mjs" });
    expect(pkg.files).toEqual(["dist"]);
    expect(pkg.type).toBe("module");
    expect(pkg.license).toBe("MIT");
  });

  it("runs on Node 22 or newer", () => {
    expect(pkg.engines).toEqual({ node: ">=22" });
  });

  it("has no runtime dependency", () => {
    expect(pkg.dependencies).toBeUndefined();
    expect(pkg.optionalDependencies).toBeUndefined();
    expect(pkg.peerDependencies).toBeUndefined();
  });

  it("starts its executable with a shebang", () => {
    expect(read("src/cli.ts").startsWith("#!/usr/bin/env node\n")).toBe(true);
  });

  it("reports the version package.json has", () => {
    expect(VERSION).toBe(pkg.version);
  });
});

describe("release-please", () => {
  it("bumps the minor for a breaking change and the patch for a feature while the version is 0.y.z", () => {
    expect(config["bump-minor-pre-major"]).toBe(true);
    expect(config["bump-patch-for-minor-pre-major"]).toBe(true);
    expect(config["release-type"]).toBe("node");
  });

  it("tags v<version>, which it finds only with the component left out of the tag", () => {
    expect(config["include-component-in-tag"]).toBe(false);
    expect(config["include-v-in-tag"]).toBe(true);
  });

  it("titles its PR Release <version>", () => {
    expect(config["pull-request-title-pattern"]).toBe("Release ${version}");
  });

  it("is one package at the root, whose version is package.json's", () => {
    expect(Object.keys(config.packages)).toEqual(["."]);
    expect(manifest).toEqual({ ".": pkg.version });
  });

  it("updates src/version.ts, whose version line carries its annotation", () => {
    expect(config.packages["."]["extra-files"]).toEqual(["src/version.ts"]);
    expect(read("src/version.ts")).toMatch(/^export const VERSION = "\d+\.\d+\.\d+"; \/\/ x-release-please-version$/m);
  });

  it("forces 0.1.0 for the first version only: release-as goes once the placeholder's 0.0.0 is behind", () => {
    if (pkg.version === "0.0.0") expect(config.packages["."]["release-as"]).toBe("0.1.0");
    else expect(config.packages["."]["release-as"]).toBeUndefined();
  });

  it.skipIf(!existsSync(new URL("../CHANGELOG.md", import.meta.url)))("writes a changelog with no em dash", () => {
    const changelog = read("CHANGELOG.md");
    expect(changelog.startsWith("# Changelog\n")).toBe(true);
    expect(changelog).not.toContain("—");
  });
});
