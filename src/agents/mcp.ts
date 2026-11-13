// The docs' MCP server, added to the project's own MCP file for each coding agent, under the name
// haau3. These files are the person's, and an entry in them is a server their agent will run or
// call, so haau3 is strict both ways. An entry counts as already there only when it is exactly the
// one haau3 writes: a haau3 entry that differs in any way (another address, a command beside the
// address) is never called set up, and never changed. And a file is rewritten only when it would read
// back exactly as it was, layout included, with the entry added; a file haau3 cannot be sure of (one
// with comments, its own layout, a multi-line string, an unusual spelling) is left as it is, with the
// entry to add said instead.
import type { Agent } from "./detect.js";
import { inspectProjectFile, textOf, writeProjectFile, type FileOutcome } from "./files.js";

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

/** Whether an entry is exactly this one: the same keys, each the same string. */
function sameEntry(entry: unknown, wanted: Record<string, string>): boolean {
  if (!isPlainObject(entry)) return false;
  const keys = Object.keys(entry);
  return keys.length === Object.keys(wanted).length && keys.every((key) => Object.hasOwn(wanted, key) && entry[key] === wanted[key]);
}

type Plan = { kind: "write"; text: string } | { kind: "unchanged" } | { kind: "left"; why: string };

/** The indent a JSON file uses: its first indented line's, else two spaces. */
function indentOf(text: string): string {
  const line = /\n([ \t]+)\S/.exec(text);
  return line ? line[1]! : "  ";
}

/** The JSON file with the entry added, or why not. */
export function planJson(text: string | null, target: JsonTarget, url: string): Plan {
  const entry = target.entry(url);
  const fresh = `${JSON.stringify({ [target.container]: { [SERVER_NAME]: entry } }, null, 2)}\n`;
  if (text === null || text.trim() === "") return { kind: "write", text: fresh };
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
    return sameEntry(servers[SERVER_NAME], entry)
      ? { kind: "unchanged" }
      : { kind: "left", why: `${target.file} already has an entry named ${SERVER_NAME} that is not exactly the docs' server, so haau3 left it as it is` };
  }
  // Rewritten only when the file is laid out as JSON.stringify lays it out, indented or on one line:
  // then it reads back exactly as it was, with only the entry new. Any other layout is the person's.
  const eol = body.includes("\r\n") ? "\r\n" : "\n";
  const unix = body.replace(/\r\n/g, "\n");
  const trailing = unix.endsWith("\n");
  const plain = trailing ? unix.slice(0, -1) : unix;
  const indent = [indentOf(unix), ""].find((candidate) => JSON.stringify(root, null, candidate) === plain);
  if (indent === undefined) return { kind: "left", why: `${target.file} is laid out in a way haau3 cannot write back exactly, so haau3 left it as it is` };
  const updated: Record<string, unknown> = { ...root, [target.container]: { ...(servers ?? {}), [SERVER_NAME]: entry } };
  const out = `${JSON.stringify(updated, null, indent)}${trailing ? "\n" : ""}`;
  return { kind: "write", text: `${bom ? "\uFEFF" : ""}${eol === "\r\n" ? out.replace(/\n/g, "\r\n") : out}` };
}

/** A table header for haau3's own server, spelled the one way haau3 reads. */
const HAAU3_TABLE = /^[ \t]*\[mcp_servers\.haau3\][ \t]*(?:#.*)?$/;
/** The only lines that may name mcp_servers: a plain table header, for the servers or for one by a bare name. */
const PLAIN_HEADER = /^[ \t]*\[mcp_servers(?:\.[A-Za-z0-9_-]+)?\][ \t]*(?:#.*)?$/;
const ANY_HEADER = /^[ \t]*\[/;

/** Codex's config.toml with the table added, or why not. Read by lines, so only as far as lines are certain. */
export function planToml(text: string | null, file: string, url: string): Plan {
  const table = `[mcp_servers.${SERVER_NAME}]\nurl = ${JSON.stringify(url)}\n`;
  if (text === null || text.trim() === "") return { kind: "write", text: table };
  const bom = text.startsWith("\uFEFF");
  const body = bom ? text.slice(1) : text;
  const leave = (why: string): Plan => ({ kind: "left", why: `${file} ${why}, so haau3 left it as it is` });
  // A multi-line string can hold anything, a line that looks like a table included.
  if (body.includes('"""') || body.includes("'''")) return leave("holds a multi-line string");
  const lines = body.split(/\r?\n/);
  if (lines.some((line) => line.includes("mcp_servers") && !PLAIN_HEADER.test(line))) return leave("names mcp_servers in a way haau3 does not read");
  const at = lines.findIndex((line) => HAAU3_TABLE.test(line));
  if (at !== -1) {
    const end = lines.findIndex((line, i) => i > at && ANY_HEADER.test(line));
    const content = lines.slice(at + 1, end === -1 ? lines.length : end).filter((line) => line.trim() !== "" && !line.trimStart().startsWith("#"));
    const exactly = content.length === 1 && /^[ \t]*url[ \t]*=[ \t]*"([^"\\]*)"[ \t]*$/.exec(content[0]!)?.[1] === url;
    return exactly ? { kind: "unchanged" } : leave(`already has an ${SERVER_NAME} server that is not exactly the docs' server`);
  }
  const servers = lines.findIndex((line) => /^[ \t]*\[mcp_servers\][ \t]*(?:#.*)?$/.test(line));
  if (servers !== -1) {
    const end = lines.findIndex((line, i) => i > servers && ANY_HEADER.test(line));
    if (lines.slice(servers + 1, end === -1 ? lines.length : end).some((line) => line.includes(SERVER_NAME))) return leave(`already names an ${SERVER_NAME} server in a way haau3 does not read`);
  }
  const eol = body.includes("\r\n") ? "\r\n" : "\n";
  const ending = body.endsWith("\n") ? "" : eol;
  return { kind: "write", text: `${bom ? "\uFEFF" : ""}${body}${ending}${eol}${table.replace(/\n/g, eol)}` };
}

/** Adds the entry to each agent's file. */
export function addMcpEntries(cwd: string, agents: readonly Agent[], url: string): FileOutcome[] {
  return agents.map((agent): FileOutcome => {
    const target = MCP_TARGETS[agent];
    const file = target.file;
    const inspected = inspectProjectFile(cwd, file, MAX_MCP_BYTES);
    if (!inspected.ok) return { file, result: "left", why: inspected.why, link: inspected.link };
    let text: string | null = null;
    if (inspected.exists) {
      if (inspected.bytes === null) return { file, result: "left", why: `${file} is too large to be an MCP file haau3 writes, so haau3 left it as it is` };
      text = textOf(inspected.bytes);
      if (text === null) return { file, result: "left", why: `${file} is not UTF-8 text, so haau3 left it as it is` };
    }
    const plan = target.format === "json" ? planJson(text, target, url) : planToml(text, file, url);
    if (plan.kind === "unchanged") return { file, result: "unchanged" };
    if (plan.kind === "left") return { file, result: "left", why: plan.why };
    try {
      writeProjectFile(cwd, inspected.path, plan.text, inspected.mode);
    } catch {
      return { file, result: "left", why: `${file} could not be written` };
    }
    return { file, result: inspected.exists ? "updated" : "created" };
  });
}
