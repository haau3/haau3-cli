// Which coding agents a project uses: from the files each agent keeps in a project, and from the agent
// running this command, by the markers it sets in its shell. Nothing is asked of any program.
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { CODEX_MARKERS } from "../output.js";

export const AGENTS = ["claude-code", "cursor", "codex", "vscode", "gemini-cli"] as const;
export type Agent = (typeof AGENTS)[number];

export const AGENT_NAMES: Readonly<Record<Agent, string>> = {
  "claude-code": "Claude Code",
  cursor: "Cursor",
  codex: "Codex",
  vscode: "VS Code",
  "gemini-cli": "Gemini CLI",
};

/**
 * The files that say a project uses an agent. VS Code counts only by its MCP file or Copilot's
 * instructions: a .vscode folder alone is any editor's settings.
 */
const PROJECT_SIGNS: Readonly<Record<Agent, readonly string[]>> = {
  "claude-code": [".claude", "CLAUDE.md", ".mcp.json"],
  cursor: [".cursor", ".cursorrules"],
  codex: [".codex"],
  vscode: [".vscode/mcp.json", ".github/copilot-instructions.md"],
  "gemini-cli": [".gemini", "GEMINI.md"],
};

/** The markers each agent sets in the shells it runs commands in. */
const RUNNING_MARKERS: Readonly<Record<Agent, readonly string[]>> = {
  "claude-code": ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"],
  cursor: ["CURSOR_AGENT"],
  codex: [...CODEX_MARKERS, "CODEX_INTERNAL_ORIGINATOR_OVERRIDE"],
  vscode: [],
  "gemini-cli": ["GEMINI_CLI"],
};

export interface Detected {
  agent: Agent;
  /** What said so: a file in the project, or the agent running this command. */
  by: string;
}

function present(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** The agents found, each once, in AGENTS' order, with the first sign of each. */
export function detectAgents(cwd: string, env: NodeJS.ProcessEnv): Detected[] {
  const found: Detected[] = [];
  for (const agent of AGENTS) {
    const marker = RUNNING_MARKERS[agent].find((name) => Boolean(env[name]?.trim()));
    if (marker) {
      found.push({ agent, by: "it is running this command" });
      continue;
    }
    const sign = PROJECT_SIGNS[agent].find((relative) => present(join(cwd, ...relative.split("/"))));
    if (sign) found.push({ agent, by: sign });
  }
  return found;
}

export function isAgent(name: string): name is Agent {
  return (AGENTS as readonly string[]).includes(name);
}
