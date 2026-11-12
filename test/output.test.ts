// The document every command prints, and when it is printed instead of text.
import { describe, expect, it } from "vitest";
import { AGENT_MARKERS, agentDetected, askedFormat, chooseFormat, CODEX_MARKERS, EXIT, failure, FORMAT_VERSION, render, success } from "../src/output.js";
import { VERSION } from "../src/version.js";

describe("the document", () => {
  it("is version 1.3 of its shape", () => {
    expect(FORMAT_VERSION).toBe("1.3");
  });

  it("carries every field, in one order, on success", () => {
    const document = success("version", { version: VERSION }, "sandbox");
    expect(Object.keys(document)).toEqual(["formatVersion", "cli", "cliVersion", "command", "ok", "environment", "data", "error"]);
    expect(document).toEqual({
      formatVersion: "1.3",
      cli: "haau3",
      cliVersion: VERSION,
      command: "version",
      ok: true,
      environment: "sandbox",
      data: { version: VERSION },
      error: null,
    });
  });

  it("carries the same fields on failure, with data null and the API's problem when there is one", () => {
    const error = {
      code: "api-refused",
      message: "The API refused the key.",
      next: [{ command: "npx haau3 --help", description: "See what haau3 can do." }],
      problem: { type: "https://docs.haau3.com/errors#invalid-key", title: "Invalid key", status: 401, code: "invalid-key", requestId: "req_1" },
    };
    const document = failure("doctor", error, "production");
    expect(Object.keys(document)).toEqual(["formatVersion", "cli", "cliVersion", "command", "ok", "environment", "data", "error"]);
    expect(document.ok).toBe(false);
    expect(document.data).toBeNull();
    expect(document.error).toEqual(error);
  });

  it("names no environment unless one is given", () => {
    expect(success("help", {}).environment).toBeNull();
    expect(failure(null, { code: "x", message: "y", next: [] }).environment).toBeNull();
  });

  it("renders as one JSON document ending in a newline", () => {
    const text = render(success("version", { version: VERSION }));
    expect(text.endsWith("}\n")).toBe(true);
    expect(JSON.parse(text).cli).toBe("haau3");
  });

  it("has three exit codes", () => {
    expect(EXIT).toEqual({ ok: 0, failed: 1, usage: 2 });
  });
});

describe("the format", () => {
  it.each([
    // [--json, stdout a terminal, environment, format]
    [false, true, {}, "text"],
    [false, false, {}, "json"],
    [true, true, {}, "json"],
    [false, true, { HAAU3_OUTPUT: "json" }, "json"],
    [false, false, { HAAU3_OUTPUT: "text" }, "text"],
    [false, false, { HAAU3_OUTPUT: " TEXT " }, "text"],
    [true, true, { HAAU3_OUTPUT: "text" }, "json"],
    [false, true, { HAAU3_OUTPUT: "yaml" }, "text"],
    [false, false, { HAAU3_OUTPUT: "" }, "json"],
    [false, true, { HAAU3_OUTPUT: "text", CODEX_SANDBOX: "seatbelt" }, "text"],
  ] as const)("--json %s, terminal %s, %j: %s", (jsonFlag, tty, env, format) => {
    expect(chooseFormat(jsonFlag, tty, env)).toBe(format);
  });

  it.each(CODEX_MARKERS)("is JSON at a terminal when Codex's %s is set", (marker) => {
    expect(chooseFormat(false, true, { [marker]: "1" })).toBe("json");
    // Set but empty is not set.
    expect(chooseFormat(false, true, { [marker]: "" })).toBe("text");
  });

  it("reads Codex's four markers", () => {
    expect([...CODEX_MARKERS]).toEqual(["CODEX_SANDBOX", "CODEX_THREAD_ID", "CODEX_SANDBOX_NETWORK_DISABLED", "CODEX_CI"]);
  });

  it.each(AGENT_MARKERS)("is JSON at a terminal when an agent's %s is set", (marker) => {
    expect(chooseFormat(false, true, { [marker]: "1" })).toBe("json");
    expect(agentDetected({ [marker]: "1" })).toBe(true);
    expect(agentDetected({ [marker]: " " })).toBe(false);
  });

  it("reads every agent's marker, Codex's among them, and not the bare AGENT", () => {
    expect(AGENT_MARKERS).toEqual(expect.arrayContaining([...CODEX_MARKERS, "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CURSOR_AGENT", "GEMINI_CLI", "AI_AGENT"]));
    expect(AGENT_MARKERS).toHaveLength(18);
    expect(agentDetected({ AGENT: "1" })).toBe(false);
    expect(chooseFormat(false, true, { AGENT: "1" })).toBe("text");
  });

  it("counts only --json and HAAU3_OUTPUT as asked for", () => {
    expect(askedFormat(true, {})).toBe("json");
    expect(askedFormat(false, { HAAU3_OUTPUT: "json" })).toBe("json");
    expect(askedFormat(false, { HAAU3_OUTPUT: "text" })).toBe("text");
    expect(askedFormat(false, { CODEX_CI: "1" })).toBeNull();
    expect(askedFormat(false, {})).toBeNull();
  });
});
