// The files init writes for coding agents, read and planned without a project: the MCP entry merged
// into JSON or Codex's TOML exactly as each agent reads it, and the skill recognised by its frontmatter.
import { describe, expect, it } from "vitest";
import { MCP_TARGETS, planJson, planToml } from "../src/agents/mcp.js";
import { isHaau3Skill } from "../src/agents/skill.js";

const URL = "https://docs.haau3.com/mcp";
const claude = MCP_TARGETS["claude-code"];
if (claude.format !== "json") throw new Error("Claude Code's file is JSON");

describe("the MCP entry in a JSON file", () => {
  it("keeps the file's line endings, byte-order mark and last line", () => {
    const crlf = planJson('{\r\n\t"mcpServers": {}\r\n}\r\n', claude, URL);
    expect(crlf).toEqual({ kind: "write", text: `{\r\n\t"mcpServers": {\r\n\t\t"haau3": {\r\n\t\t\t"type": "http",\r\n\t\t\t"url": "${URL}"\r\n\t\t}\r\n\t}\r\n}\r\n` });
    const bom = planJson('\uFEFF{"a": 1}', claude, URL);
    expect(bom.kind === "write" && bom.text.startsWith('\uFEFF{\n  "a": 1,')).toBe(true);
    expect(bom.kind === "write" && bom.text.endsWith("}")).toBe(true);
  });

  it("leaves what it cannot be sure of", () => {
    for (const text of ["[]", "null", '{"mcpServers": []}', '{"mcpServers": {"haau3": "x"}}', "{ // no\n}", '{"a": 1e400}']) {
      expect(planJson(text, claude, URL).kind, text).toBe("left");
    }
    expect(planJson(`{"mcpServers": {"haau3": {"url": "${URL}"}}}`, claude, URL)).toEqual({ kind: "unchanged" });
  });

  it("never lets a key named __proto__ change what is written", () => {
    const plan = planJson('{"__proto__": {"polluted": true}, "mcpServers": {}}', claude, URL);
    expect(plan.kind).toBe("write");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("the MCP entry in Codex's config.toml", () => {
  it("adds a table, finds one already there, and leaves other spellings", () => {
    expect(planToml(null, "c", URL)).toEqual({ kind: "write", text: `[mcp_servers.haau3]\nurl = "${URL}"\n` });
    expect(planToml('model = "x"', "c", URL)).toEqual({ kind: "write", text: `model = "x"\n\n[mcp_servers.haau3]\nurl = "${URL}"\n` });
    expect(planToml(`[mcp_servers."haau3"]  # docs\nurl = "${URL}"\n`, "c", URL)).toEqual({ kind: "unchanged" });
    expect(planToml('[mcp_servers.haau3]\nurl = "https://example.com"\n', "c", URL).kind).toBe("left");
    expect(planToml('[mcp_servers]\nhaau3 = { url = "x" }\n', "c", URL).kind).toBe("left");
    expect(planToml('mcp_servers.haau3.url = "x"\n', "c", URL).kind).toBe("left");
    expect(planToml('[mcp_servers]\nother = { url = "x" }\n', "c", URL).kind).toBe("write");
  });
});

describe("the skill's frontmatter", () => {
  it("must come first and name the skill haau3, with a description", () => {
    expect(isHaau3Skill("---\nname: haau3\ndescription: x\n---\nbody")).toBe(true);
    expect(isHaau3Skill('---\r\nname: "haau3"\r\ndescription: x\r\n---\r\n')).toBe(true);
    for (const text of ["name: haau3\ndescription: x", "---\nname: haau3x\ndescription: x\n---\n", "---\nname: haau3\n---\n", "# title\n---\nname: haau3\ndescription: x\n---\n"]) {
      expect(isHaau3Skill(text), text).toBe(false);
    }
  });
});
