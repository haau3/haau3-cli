// Running a project's own tools: found by full path on PATH and never in the project or a
// node_modules folder, a Windows .cmd shim started through cmd.exe with nothing it would expand, a
// time limit kept, and only haau3's own constant arguments passed.
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findProgram, runProgram, shimLine } from "../src/run.js";
import { parseChoice } from "../src/terminal.js";

let root: string;
/** The project a program is run for: never the folder its tools are in. */
let away: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cli-run-"));
  away = mkdtempSync(join(tmpdir(), "cli-run-project-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(away, { recursive: true, force: true });
});

/** A program that runs a line of Node, as a script on POSIX and a .cmd shim on Windows. */
function program(folder: string, name: string, source: string): void {
  mkdirSync(folder, { recursive: true });
  const script = join(folder, `${name}.mjs`);
  writeFileSync(script, source);
  if (process.platform === "win32") {
    writeFileSync(join(folder, `${name}.cmd`), `@"${process.execPath}" "${script}" %*\r\n`);
  } else {
    writeFileSync(join(folder, name), `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
    chmodSync(join(folder, name), 0o755);
  }
}

describe("finding a program", () => {
  it("skips the project, anything in it, and node_modules folders, wherever they are on PATH", () => {
    const project = join(root, "project");
    const real = join(root, "tools");
    for (const folder of [join(project, "bin"), join(root, "elsewhere", "node_modules", ".bin"), real]) program(folder, "pm", "");
    const path = [join(project, "bin"), project, join(root, "elsewhere", "node_modules", ".bin"), "relative", "", real].join(delimiter);
    const found = findProgram("pm", { PATH: path, Path: path }, project, process.platform, [".exe", ".cmd"]);
    expect(found?.path.startsWith(real)).toBe(true);
    expect(found?.shim).toBe(process.platform === "win32");
    expect(findProgram("pm", { PATH: join(project, "bin") }, project, process.platform, [".exe", ".cmd"])).toBeNull();
  });

  it("finds a .cmd shim on Windows only when asked to", () => {
    const tools = join(root, "tools");
    program(tools, "pm", "");
    if (process.platform !== "win32") return;
    expect(findProgram("pm", { Path: tools }, away, "win32", [".exe"])).toBeNull();
    expect(findProgram("pm", { Path: tools }, away, "win32", [".exe", ".cmd"])?.shim).toBe(true);
  });
});

describe("the line cmd.exe runs for a shim", () => {
  it("quotes the path, and refuses one cmd.exe would expand", () => {
    expect(shimLine("C:\\Program Files\\nodejs\\npm.cmd", ["install", "@haau3/sdk"])).toBe('""C:\\Program Files\\nodejs\\npm.cmd" install @haau3/sdk"');
    for (const bad of ["C:\\a%PATH%\\npm.cmd", 'C:\\a"b\\npm.cmd', "C:\\a&b\\npm.cmd", "C:\\a^b\\npm.cmd", "C:\\a!b\\npm.cmd"]) expect(shimLine(bad, ["install"])).toBeNull();
  });
});

describe("running a program", () => {
  it("passes its arguments, reports its exit code and hands its output only to the caller", async () => {
    const tools = join(root, "tools");
    program(tools, "pm", 'console.log("args:" + process.argv.slice(2).join(","));\nprocess.exit(4);\n');
    const found = findProgram("pm", { PATH: tools, Path: tools }, away, process.platform, [".exe", ".cmd"])!;
    let output = "";
    const ran = await runProgram(found, ["add", "@haau3/sdk"], { cwd: away, env: { ...process.env }, timeoutMs: 20_000, output: (text) => (output += text) });
    expect(ran).toEqual({ kind: "exited", code: 4 });
    expect(output).toContain("args:add,@haau3/sdk");
  });

  it("stops a program that runs past its time", async () => {
    const tools = join(root, "tools");
    program(tools, "slow", "setTimeout(() => {}, 60_000);\n");
    const found = findProgram("slow", { PATH: tools, Path: tools }, away, process.platform, [".exe", ".cmd"])!;
    const started = Date.now();
    expect(await runProgram(found, [], { cwd: away, env: { ...process.env }, timeoutMs: 1_000 })).toEqual({ kind: "timed-out" });
    expect(Date.now() - started).toBeLessThan(15_000);
  });

  it("takes only haau3's own constant arguments", async () => {
    const found = { path: process.execPath, shim: false };
    for (const bad of ["a b", "a;b", "$(x)", "a&b", "%x%"]) {
      await expect(async () => runProgram(found, [bad], { cwd: away, env: {}, timeoutMs: 1_000 })).rejects.toThrow("haau3's own constants");
    }
  });
});

describe("reading a person's choice", () => {
  it("takes one number, or several for a question that allows them, and nothing else", () => {
    expect(parseChoice("2", 3, false)).toEqual([1]);
    expect(parseChoice(" 1, 3 ", 3, true)).toEqual([0, 2]);
    expect(parseChoice("1 1 2", 3, true)).toEqual([0, 1]);
    for (const answer of ["", "0", "4", "1,2", "x", "1.5", "-1"]) expect(parseChoice(answer, 3, false), answer).toBeNull();
    expect(parseChoice("1,9", 3, true)).toBeNull();
  });
});
