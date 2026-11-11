// Where the command line finds an API key, and what it says about one. The keys are made up.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { environmentOf, findKey, KEY_FILES, modeOf, notNeeded } from "../src/key.js";

const LIVE = ["haau3", "sk", "live", "a1b2c3d4e5f6"].join("_");
const TEST = ["haau3", "sk", "test", "f6e5d4c3b2a1"].join("_");
const OTHER_LIVE = ["haau3", "sk", "live", "zzzzzzzzzzzz"].join("_");

let project: string;
beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), "cli-key-"));
});
afterEach(() => {
  rmSync(project, { recursive: true, force: true });
});
const file = (name: string, text: string) => writeFileSync(join(project, name), text);

describe("where the key is found", () => {
  it("takes the environment first", () => {
    file(".env.local", `HAAU3_API_KEY=${OTHER_LIVE}\n`);
    file(".env", `HAAU3_API_KEY=${OTHER_LIVE}\n`);
    const { report, key } = findKey({ cwd: project, env: { HAAU3_API_KEY: TEST } });
    expect(report).toEqual({ status: "found", source: "environment", mode: "test", environment: "sandbox" });
    expect(key?.reveal()).toBe(TEST);
  });

  it("then .env.local, over .env", () => {
    file(".env.local", `HAAU3_API_KEY=${LIVE}\n`);
    file(".env", `HAAU3_API_KEY=${OTHER_LIVE}\n`);
    const { report, key } = findKey({ cwd: project, env: {} });
    expect(report).toEqual({ status: "found", source: ".env.local", mode: "live", environment: "production" });
    expect(key?.reveal()).toBe(LIVE);
  });

  it("then .env", () => {
    file(".env", `HAAU3_API_KEY=${LIVE}\n`);
    expect(findKey({ cwd: project, env: {} }).report).toMatchObject({ status: "found", source: ".env" });
  });

  it("passes over an empty or blank value, as an application finds no key there", () => {
    file(".env.local", "HAAU3_API_KEY=\n");
    file(".env", `HAAU3_API_KEY=${LIVE}\n`);
    expect(findKey({ cwd: project, env: { HAAU3_API_KEY: "  " } }).report).toMatchObject({ source: ".env" });
  });

  it("reads only the folder it runs in", () => {
    const sub = join(project, "sub");
    mkdirSync(sub);
    file(".env", `HAAU3_API_KEY=${LIVE}\n`);
    expect(findKey({ cwd: sub, env: {} }).report).toEqual({ status: "not-found", looked: ["environment", ...KEY_FILES] });
  });

  it("says where it looked when there is no key", () => {
    file(".env", "OTHER=1\n");
    const result = findKey({ cwd: project, env: {} });
    expect(result).toEqual({ report: { status: "not-found", looked: ["environment", ".env.local", ".env"] }, key: null });
  });

  it("passes over an env file it cannot read as one: a folder, or a file over 1 MB", () => {
    mkdirSync(join(project, ".env.local"));
    file(".env", `HAAU3_API_KEY=${LIVE}\n${"#".repeat(1024 * 1024)}\n`);
    expect(findKey({ cwd: project, env: {} }).report.status).toBe("not-found");
  });

  it("reads the lines env files are written with", () => {
    for (const text of [
      `export HAAU3_API_KEY=${LIVE}\n`,
      `HAAU3_API_KEY="${LIVE}"\n`,
      `HAAU3_API_KEY='${LIVE}'\n`,
      `# a comment\r\nHAAU3_API_KEY=${LIVE}\r\nOTHER=x\r\n`,
      `HAAU3_API_KEY=${LIVE} # a comment\n`,
      `HAAU3_API_KEY=${OTHER_LIVE}\nHAAU3_API_KEY=${LIVE}\n`,
    ]) {
      file(".env", text);
      expect(findKey({ cwd: project, env: {} }).key?.reveal(), text).toBe(LIVE);
    }
  });

  it("reports facts about the key and nothing of the file's other lines", () => {
    file(".env.local", `DATABASE_URL=postgres://user:pass@host/db\nHAAU3_API_KEY=${LIVE}\nOTHER_SECRET=abc\n`);
    const text = JSON.stringify(findKey({ cwd: project, env: {} }));
    expect(text).toBe('{"report":{"status":"found","source":".env.local","mode":"live","environment":"production"},"key":"[haau3 key hidden]"}');
  });
});

describe("what a key says about itself", () => {
  it("has a mode from its prefix", () => {
    expect(modeOf(LIVE)).toBe("live");
    expect(modeOf(TEST)).toBe("test");
    expect(modeOf("sk_live_123")).toBe("unrecognized");
    expect(modeOf(` ${LIVE}`)).toBe("unrecognized");
  });

  it("reaches production when live and the Sandbox when test", () => {
    expect(environmentOf("live")).toBe("production");
    expect(environmentOf("test")).toBe("sandbox");
    expect(environmentOf("unrecognized")).toBeNull();
  });

  it("names no environment when it is not a haau3 key", () => {
    expect(findKey({ cwd: project, env: { HAAU3_API_KEY: "not-a-key" } }).report).toEqual({
      status: "found",
      source: "environment",
      mode: "unrecognized",
      environment: null,
    });
  });
});

describe("a call that needs no key", () => {
  it("is reported as not needed, with its environment, and holds no key", () => {
    expect(notNeeded("sandbox")).toEqual({ report: { status: "not-needed", environment: "sandbox" }, key: null });
  });
});
