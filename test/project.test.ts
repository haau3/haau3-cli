// What a project's own files say about its haau3 SDK, read a line at a time with patterns that cannot
// backtrack, and nothing run. The forms are the ones the tools write: pip, pip-compile, poetry and uv
// export, PEP 621, Poetry, Pipfile and go.mod.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readSmallText } from "../src/files.js";
import { readProject } from "../src/project.js";

let folder: string;
beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), "cli-project-"));
});
afterEach(() => rmSync(folder, { recursive: true, force: true }));

const write = (name: string, text: string) => {
  mkdirSync(join(folder, name, ".."), { recursive: true });
  writeFileSync(join(folder, name), text);
};
const sdk = () => readProject(folder).sdks[0];

describe("Python", () => {
  for (const [file, text, declared, verdict] of [
    ["requirements.txt", "haau3==0.3.0 ; python_version >= '3.9'\n", "==0.3.0", "below"],
    ["requirements.txt", "haau3==0.4.1 \\\n    --hash=sha256:abc\n", "==0.4.1", "ok"],
    ["requirements.txt", "haau3>=0.3\n", ">=0.3", "allows-below"],
    ["requirements.txt", "haau3 >= 0.3\n", ">= 0.3", "allows-below"],
    ["requirements.txt", "haau3~=0.3\n", "~=0.3", "allows-below"],
    ["requirements.txt", "haau3<0.4\n", "<0.4", "below"],
    ["requirements.txt", "haau3<=0.3.9\n", "<=0.3.9", "below"],
    ["requirements.txt", "haau3>=0.3,<0.4\n", ">=0.3,<0.4", "below"],
    ["requirements.txt", "haau3>=0.4.0,<0.5\n", ">=0.4.0,<0.5", "ok"],
    ["requirements.txt", "haau3[async]>=0.4.1  # pinned\n", ">=0.4.1", "ok"],
    ["requirements.txt", "haau3 @ git+https://github.com/haau3/haau3-python\n", null, null],
    ["pyproject.toml", '[project]\nkeywords = ["haau3"]\ndependencies = [\n  "httpx>=0.27",\n  "haau3==0.3.0",\n]\n', "==0.3.0", "below"],
    ["pyproject.toml", '[project]\n# dependencies = ["haau3==0.1.0"]\ndependencies = ["haau3>=0.4.0"]\n', ">=0.4.0", "ok"],
    ["pyproject.toml", '[dependency-groups]\ndev = ["haau3==0.4.1"]\n', "==0.4.1", "ok"],
    ["pyproject.toml", '[tool.poetry.dependencies]\nhaau3 = { version = "^0.3.0", extras = ["x"] }\n', "^0.3.0", "below"],
    ["Pipfile", '[packages]\nhaau3 = "==0.4.1"\n', "==0.4.1", "ok"],
  ] as const) {
    it(`reads ${file}: ${JSON.stringify(text).slice(1, 50)}`, () => {
      write(file, text);
      expect(sdk()).toMatchObject({ language: "python", manifest: file, declared, verdict });
    });
  }

  it("takes nothing that only looks like haau3, or sits outside a dependency list", () => {
    for (const [file, text] of [
      ["requirements.txt", "haau3x==1.0\nhaau3_x==1\n"],
      ["pyproject.toml", '[tool.other]\nhaau3 = "0.1"\n[project]\nkeywords = ["haau3"]\n'],
    ] as const) {
      rmSync(folder, { recursive: true, force: true });
      mkdirSync(folder);
      write(file, text);
      expect(sdk(), file).toBeUndefined();
    }
  });
});

describe("Go", () => {
  it("reads the require block, never exclude or replace", () => {
    write("go.mod", "module x\n\nexclude (\n\tgithub.com/haau3/haau3-go v0.1.0\n)\n\nrequire (\n\tgithub.com/haau3/haau3-go v0.3.1 // indirect\n)\n");
    expect(sdk()).toMatchObject({ language: "go", declared: "v0.3.1", verdict: "ok" });
  });
});

describe("Node", () => {
  it("reads a caret on 0.x as npm does: ^0.3.9 never reaches 0.4.0", () => {
    write("package.json", JSON.stringify({ dependencies: { "@haau3/sdk": "^0.3.9" } }));
    expect(sdk()).toMatchObject({ declared: "^0.3.9", installed: null, verdict: "below" });
  });

  it("takes a copy installed above only for a project that names the SDK, and says where it is", () => {
    write("node_modules/@haau3/sdk/package.json", JSON.stringify({ version: "0.4.2", engines: { node: ">=30" } }));
    write("app/package.json", JSON.stringify({ name: "app" }));
    expect(readProject(join(folder, "app"))).toMatchObject({ sdks: [], nodeFloor: null });
    write("app/package.json", JSON.stringify({ dependencies: { "@haau3/sdk": "^0.4.0" } }));
    expect(readProject(join(folder, "app"))).toMatchObject({ sdks: [{ installed: "0.4.2", installedAbove: true, verdict: "ok" }], nodeFloor: 30 });
  });
});

describe("a crafted manifest", () => {
  it("is read in well under a second, whatever its lines hold", () => {
    const cases: [string, string][] = [
      ["requirements.txt", `haau3${" ".repeat(4000)}@\n`],
      ["requirements.txt", `${" ".repeat(80_000)}\n`],
      ["pyproject.toml", `[project]\ndependencies = ["haau3${" ".repeat(4000)}@"]\n`],
      ["go.mod", "\n".repeat(80_000)],
      ["Pipfile", `[packages]\n${"\n".repeat(80_000)}`],
    ];
    for (const [file, text] of cases) {
      rmSync(folder, { recursive: true, force: true });
      mkdirSync(folder);
      write(file, text);
      const started = performance.now();
      readProject(folder);
      expect(performance.now() - started, file).toBeLessThan(1000);
    }
    write("node_modules/@haau3/sdk/package.json", JSON.stringify({ version: "9".repeat(80_000) }));
    write("package.json", JSON.stringify({ dependencies: { "@haau3/sdk": "^0.4.0" } }));
    const started = performance.now();
    readProject(folder);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe("reading a small file", () => {
  it("says a FIFO is not a file without waiting on it, and UTF-16 is not text", () => {
    write("utf16.env", "");
    writeFileSync(join(folder, "utf16.env"), Buffer.from("﻿HAAU3_API_KEY=x\n", "utf16le"));
    expect(readSmallText(join(folder, "utf16.env"), 1024)).toEqual({ state: "unreadable", why: "not-text" });
    expect(readSmallText(join(folder, "none.env"), 1024)).toEqual({ state: "missing" });
    expect(readSmallText(folder, 1024)).toMatchObject({ state: "unreadable" });
    if (process.platform !== "win32") {
      execFileSync("mkfifo", [join(folder, "pipe.env")]);
      expect(readSmallText(join(folder, "pipe.env"), 1024)).toEqual({ state: "unreadable", why: "not-a-file" });
    }
  });
});
