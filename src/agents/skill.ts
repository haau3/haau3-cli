// The haau3 Agent Skill, read from the docs, its one source, and written into the project where each
// coding agent reads skills: .claude/skills/haau3 for Claude Code, .agents/skills/haau3 for the others.
// A skill is instructions an agent follows, so what is written is checked first: it came from the
// docs' own host (a redirect to any other is refused), it is small UTF-8 text, and its frontmatter
// names the skill haau3, as the Agent Skills format requires of a skill in a folder of that name.
import { VERSION } from "../version.js";
import type { Agent } from "./detect.js";
import { inspectProjectFile, writeProjectFile, type FileOutcome } from "./files.js";

/** Where each agent reads a project's skills, for the haau3 skill. */
export const SKILL_FILES: Readonly<Record<Agent, string>> = {
  "claude-code": ".claude/skills/haau3/SKILL.md",
  cursor: ".agents/skills/haau3/SKILL.md",
  codex: ".agents/skills/haau3/SKILL.md",
  vscode: ".agents/skills/haau3/SKILL.md",
  "gemini-cli": ".agents/skills/haau3/SKILL.md",
};

/** The most a skill may be: the docs' is about 6 KB. */
export const MAX_SKILL_BYTES = 256 * 1024;

/** How long the docs may take to answer, the body included. */
export const SKILL_TIMEOUT_MS = 15_000;

/** Same-host redirects followed before giving up. */
const MAX_REDIRECTS = 3;

export type SkillFetch = { ok: true; bytes: Uint8Array; url: string } | { ok: false; why: string };

/**
 * The frontmatter keys the Agent Skills format defines that grant nothing. Others can: Claude Code's
 * allowed-tools runs tools without asking, and hooks run commands. The docs' skill has only name and
 * description.
 */
const ALLOWED_KEYS = new Set(["name", "description", "license", "compatibility", "metadata"]);

/**
 * Why the text is not the haau3 skill as haau3 writes one, or null when it is: frontmatter first,
 * naming it haau3 and describing it, with no key that grants an agent anything, and no command in
 * the body that an agent runs as it loads the skill (`!`-quoted, or a ```! block).
 */
export function skillProblem(text: string): string | null {
  const front = /^---\r?\n([\s\S]{0,4096}?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!front) return "it does not start with frontmatter";
  const lines = front[1]!.split(/\r?\n/);
  if (!lines.some((line) => /^name:[ \t]*(["']?)haau3\1[ \t]*$/.test(line))) return "its frontmatter does not name it haau3";
  if (!lines.some((line) => /^description:[ \t]*\S/.test(line))) return "its frontmatter has no description";
  for (const line of lines) {
    if (/^[ \t]/.test(line) || line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const key = /^([^:]{1,64}):/.exec(line)?.[1]?.trim().replace(/^["']|["']$/g, "");
    if (key === undefined || !ALLOWED_KEYS.has(key)) return "its frontmatter sets a key that can grant an agent something (only name, description, license, compatibility and metadata are taken)";
  }
  const body = text.slice(front[0].length);
  if (body.includes("!`") || /^[ \t]*(`{3,}|~{3,})[ \t]*!/m.test(body)) return "it holds a command an agent would run as it loads the skill";
  return null;
}

/** Whether the text reads as the haau3 skill, by skillProblem. */
export function isHaau3Skill(text: string): boolean {
  return skillProblem(text) === null;
}

async function readCapped(response: Response, max: number): Promise<Uint8Array | null> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
}

/** Reads skill.md from the docs. No key, session or cookie is sent: the docs need none. */
export async function fetchSkill(docsURL: string, fetchImpl: typeof fetch = fetch): Promise<SkillFetch> {
  const origin = new URL(docsURL).origin;
  let url = `${docsURL}/skill.md`;
  const signal = AbortSignal.timeout(SKILL_TIMEOUT_MS);
  try {
    for (let hop = 0; ; hop++) {
      const response = await fetchImpl(url, {
        method: "GET",
        redirect: "manual",
        credentials: "omit",
        headers: { accept: "text/markdown, text/plain;q=0.9", "user-agent": `haau3-cli/${VERSION}` },
        signal,
      });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel().catch(() => {});
        const location = response.headers.get("location");
        const next = location ? new URL(location, url) : null;
        if (!next || next.origin !== origin) return { ok: false, why: `${origin} sent the skill's address to another host, which haau3 does not follow` };
        if (hop >= MAX_REDIRECTS) return { ok: false, why: `${origin} redirected the skill's address more than ${MAX_REDIRECTS} times` };
        url = next.href;
        continue;
      }
      if (response.status !== 200) {
        await response.body?.cancel().catch(() => {});
        return { ok: false, why: `${origin} answered HTTP ${response.status} for the skill` };
      }
      const bytes = await readCapped(response, MAX_SKILL_BYTES);
      if (bytes === null) return { ok: false, why: `the skill from ${origin} is larger than ${MAX_SKILL_BYTES / 1024} KB, so it is not haau3's` };
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        return { ok: false, why: `the skill from ${origin} is not UTF-8 text` };
      }
      const problem = text.includes("\u0000") ? "it is not text" : skillProblem(text.replace(/^\uFEFF/, ""));
      if (problem) return { ok: false, why: `what ${origin} answered for the skill is not the haau3 skill: ${problem}` };
      return { ok: true, bytes, url };
    }
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    return { ok: false, why: name === "TimeoutError" || name === "AbortError" ? `${origin} did not answer within ${SKILL_TIMEOUT_MS / 1000} seconds` : `${origin} could not be reached` };
  }
}

/**
 * Writes the skill to each file, once each. The folder is haau3's: any regular file there that is not
 * these exact bytes is replaced, whatever it holds or however large; one already holding them is left
 * unchanged. A link in the way is refused, and said to be one.
 */
export function writeSkill(cwd: string, files: readonly string[], bytes: Uint8Array): FileOutcome[] {
  return [...new Set(files)].map((file): FileOutcome => {
    const inspected = inspectProjectFile(cwd, file, MAX_SKILL_BYTES);
    if (!inspected.ok) return { file, result: "left", why: inspected.why, link: inspected.link };
    if (inspected.bytes !== null && inspected.bytes.equals(bytes)) return { file, result: "unchanged" };
    try {
      writeProjectFile(cwd, inspected.path, bytes, inspected.mode);
    } catch {
      return { file, result: "left", why: `${file} could not be written` };
    }
    return { file, result: inspected.exists ? "updated" : "created" };
  });
}
