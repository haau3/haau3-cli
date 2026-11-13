// The docs' MCP server, added to the project's own MCP file for each coding agent, under the name
// haau3. These files are the person's: an entry is added only when none named haau3 is there, the
// rest of the file reads back exactly as it did, and a file haau3 cannot read safely (one with
// comments, an inline table) or a haau3 entry that names another server is left as it is, with the
// entry to add said instead.
import type { Agent } from "./detect.js";
import { inspectProjectFile, writeProjectFile, type FileOutcome } from "./files.js";

/** The name the entry has in every file, as the docs' own setup commands give it. */
export const SERVER_NAME = "haau3";

/** The most an MCP file may be for haau3 to read it. */
const MAX_MCP_BYTES = 1024 * 1024;

interface JsonTarget {
  format: "json";
  file: string;
  /** The object in the file that holds servers by name. */
  container: string;
  entry: (url: string) => Record<string, string>;
}

interface TomlTarget {
  format: "toml";
  file: string;
}

type Target = JsonTarget | TomlTarget;

/** Each agent's project MCP file and the shape of an entry for a server over HTTP that needs no key. */
export const MCP_TARGETS: Readonly<Record<Agent, Target>> = {
  "claude-code": { format: "json", file: ".mcp.json", container: "mcpServers", entry: (url) => ({ type: "http", url }) },
  cursor: { format: "json", file: ".cursor/mcp.json", container: "mcpServers", entry: (url) => ({ url }) },
  vscode: { format: "json", file: ".vscode/mcp.json", container: "servers", entry: (url) => ({ type: "http", url }) },
  "gemini-cli": { format: "json", file: ".gemini/settings.json", container: "mcpServers", entry: (url) => ({ httpUrl: url }) },
  codex: { format: "toml", file: ".codex/config.toml" },
};

/** What a person adds by hand when haau3 leaves the file alone. */
export function entryText(agent: Agent, url: string): string {
  const target = MCP_TARGETS[agent];
  if (target.format === "toml") return `[mcp_servers.${SERVER_NAME}]\nurl = ${JSON.stringify(url)}`;
  return `"${SERVER_NAME}": ${JSON.stringify(target.entry(url))} in "${target.container}"`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The address an entry names, whichever key its agent spells it with. */
function addressOf(entry: unknown): string | null {
  if (!isPlainObject(entry)) return null;
  for (const key of ["url", "httpUrl", "serverUrl"]) {
    if (typeof entry[key] === "string") return entry[key];
  }
  return null;
}

/** Whether every number in a parsed value is one JSON.stringify writes back as the file had it: finite, and an integer only when a safe one. */
function exactNumbers(value: unknown, depth = 0): boolean {
  if (depth > 100) return false;
  if (typeof value === "number") return Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value));
  if (Array.isArray(value)) return value.every((item) => exactNumbers(item, depth + 1));
  if (isPlainObject(value)) return Object.values(value).every((item) => exactNumbers(item, depth + 1));
  return true;
}

/** The indent a JSON file uses: its first indented line's, else two spaces. */
function indentOf(text: string): string {
  const line = /\n([ \t]+)\S/.exec(text);
  return line ? line[1]! : "  ";
}

type Plan = { kind: "write"; text: string } | { kind: "unchanged" } | { kind: "left"; why: string };

/** The JSON file with the entry added, or why not. */
export function planJson(text: string | null, target: JsonTarget, url: string): Plan {
  const entry = target.entry(url);
  if (text === null) return { kind: "write", text: `${JSON.stringify({ [target.container]: { [SERVER_NAME]: entry } }, null, 2)}\n` };
  const bom = text.startsWith("\uFEFF");
  const body = bom ? text.slice(1) : text;
  let root: unknown;
  try {
    root = JSON.parse(body);
  } catch {
    return { kind: "left", why: `${target.file} is not plain JSON (it may hold comments), so haau3 left it as it is` };
  }
  if (!isPlainObject(root)) return { kind: "left", why: `${target.file} does not hold a JSON object, so haau3 left it as it is` };
  const servers = Object.hasOwn(root, target.container) ? root[target.container] : undefined;
  if (servers !== undefined && !isPlainObject(servers)) return { kind: "left", why: `"${target.container}" in ${target.file} is not an object, so haau3 left it as it is` };
  if (servers && Object.hasOwn(servers, SERVER_NAME)) {
    return addressOf(servers[SERVER_NAME]) === url
      ? { kind: "unchanged" }
      : { kind: "left", why: `${target.file} already has an entry named ${SERVER_NAME} for another server, so haau3 left it as it is` };
  }
  // Written back, every value must read as it did: a number JavaScript cannot hold exactly would not.
  if (!exactNumbers(root)) return { kind: "left", why: `${target.file} holds a number haau3 could not write back exactly, so haau3 left it as it is` };
  const updated: Record<string, unknown> = { ...root, [target.container]: { ...(servers ?? {}), [SERVER_NAME]: entry } };
  const eol = body.includes("\r\n") ? "\r\n" : "\n";
  let out = JSON.stringify(updated, null, indentOf(body));
  if (eol === "\r\n") out = out.replace(/\n/g, "\r\n");
  const trailing = /\r?\n$/.test(body) || body.length === 0 ? eol : "";
  return { kind: "write", text: `${bom ? "\uFEFF" : ""}${out}${trailing}` };
}

const HAAU3_TABLE = /^[ \t]*\[[ \t]*mcp_servers[ \t]*\.[ \t]*(?:haau3|"haau3"|'haau3')[ \t]*\][ \t]*(?:#.*)?$/;
const ANY_HEADER = /^[ \t]*\[/;
const URL_LINE = /^[ \t]*url[ \t]*=[ \t]*"([^"\\]*)"[ \t]*(?:#.*)?$/;

/** Codex's config.toml with the table added, or why not. Read by lines, as far as it needs to be sure. */
export function planToml(text: string | null, file: string, url: string): Plan {
  const table = `[mcp_servers.${SERVER_NAME}]\nurl = ${JSON.stringify(url)}\n`;
  if (text === null) return { kind: "write", text: table };
  const lines = text.split(/\r?\n/);
  const at = lines.findIndex((line) => HAAU3_TABLE.test(line));
  if (at !== -1) {
    const end = lines.findIndex((line, i) => i > at && ANY_HEADER.test(line));
    const body = lines.slice(at + 1, end === -1 ? lines.length : end);
    const address = body.map((line) => URL_LINE.exec(line)?.[1]).find((value) => value !== undefined);
    return address === url ? { kind: "unchanged" } : { kind: "left", why: `${file} already has an ${SERVER_NAME} server that names another address, so haau3 left it as it is` };
  }
  // Any other way of spelling mcp_servers could already hold haau3, or make a new table invalid.
  if (lines.some((line) => /^[ \t]*(?:mcp_servers|"mcp_servers")[ \t]*[=.]/.test(line) || (/^[ \t]*\[\[/.test(line) && /mcp_servers/.test(line)))) {
    return { kind: "left", why: `${file} sets mcp_servers in a way haau3 does not read, so haau3 left it as it is` };
  }
  const servers = lines.findIndex((line) => /^[ \t]*\[[ \t]*(?:mcp_servers|"mcp_servers")[ \t]*\][ \t]*(?:#.*)?$/.test(line));
  if (servers !== -1) {
    const end = lines.findIndex((line, i) => i > servers && ANY_HEADER.test(line));
    const body = lines.slice(servers + 1, end === -1 ? lines.length : end);
    if (body.some((line) => /^[ \t]*["']?haau3["']?[ \t]*[=.]/.test(line))) {
      return { kind: "left", why: `${file} already names an ${SERVER_NAME} server in a way haau3 does not read, so haau3 left it as it is` };
    }
  }
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const ending = text.length === 0 || text.endsWith("\n") ? "" : eol;
  const gap = text.trim().length === 0 ? "" : eol;
  return { kind: "write", text: `${text}${ending}${gap}${table.replace(/\n/g, eol)}` };
}

/** Adds the entry to each agent's file. */
export function addMcpEntries(cwd: string, agents: readonly Agent[], url: string): FileOutcome[] {
  return agents.map((agent) => {
    const target = MCP_TARGETS[agent];
    const file = target.file;
    const inspected = inspectProjectFile(cwd, file, MAX_MCP_BYTES);
    if (!inspected.ok) return { file, result: "left", why: inspected.why };
    const plan = target.format === "json" ? planJson(inspected.text, target, url) : planToml(inspected.text, file, url);
    if (plan.kind === "unchanged") return { file, result: "unchanged" };
    if (plan.kind === "left") return { file, result: "left", why: plan.why };
    try {
      writeProjectFile(inspected.path, plan.text);
    } catch {
      return { file, result: "left", why: `${file} could not be written` };
    }
    return { file, result: inspected.text === null ? "created" : "updated" };
  });
}
