// Checks that what this repository publishes says only what this repository shows: its files, the
// messages of commits not yet on main, and a pull request's title and description. Everything here
// is public, so nothing in it refers to work, people, accounts or places outside this repository.
//
//   pnpm check:public-text                          the tracked files
//   pnpm check:public-text --commits origin/main..HEAD --text-env PR_TITLE --text-env PR_BODY
//   pnpm check:public-text --no-files --text-file body.md --terms <file>
//
// --terms adds one regular expression per line (case-insensitive, `#` starts a comment), for words
// that are fine to keep out of this file but must not be published either. It exits 1 on any match.
// A --commits range whose start does not exist yet, as before the first push, reads every commit.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

export interface Rule {
  name: string;
  pattern: RegExp;
  /** A match this returns true for is allowed. */
  allow?: (match: string, text: string, index: number) => boolean;
}

/** Words for standards and published identifiers that look like ticket numbers. */
const STANDARD_IDS = new Set(["UTF-8", "UTF-16", "UTF-32", "PHQ-2", "PHQ-9", "GAD-2", "GAD-7", "SHA-1", "SHA-2", "SHA-3", "TLS-1", "ICD-10"]);

/** Email domains a public commit or file may name. */
const EMAIL_DOMAINS = /(^|\.)(haau3\.com|users\.noreply\.github\.com|anthropic\.com|example\.(com|org|net))$/i;

export const RULES: Rule[] = [
  {
    name: "a repository of the haau3 organization other than this one and the SDKs",
    pattern: /(?<![@\w.-])haau3\/[\w.-]+/g,
    // The SDKs are public too, and this repository names them.
    allow: (match) => /^haau3\/haau3-(cli|node|python|go)(?![\w-])/.test(match),
  },
  {
    name: "a haau3 project, repository or service name other than this one's and the SDKs'",
    pattern: /\bhaau3-[a-z0-9][\w-]*/gi,
    allow: (match) => /^haau3-(cli|node|python|go|bot|sdk)\b/i.test(match),
  },
  {
    name: "an issue or pull request number without the repository it belongs to",
    pattern: /(?<![\w/&])#\d+\b|\bissues? \d+\b/gi,
    // A link release-please writes into CHANGELOG.md, to this repository's own issue or PR.
    allow: (match, text, index) =>
      match.startsWith("#") &&
      text[index - 1] === "[" &&
      text.startsWith(`${match}](https://github.com/haau3/haau3-cli/`, index),
  },
  {
    name: "a ticket or work-item id",
    pattern: /\b[A-Z]{2,10}-\d{1,2}[a-z]?\b/g,
    allow: (match) => STANDARD_IDS.has(match),
  },
  { name: "a planning word", pattern: /\b(milestones?|epics?|backlog|roadmap)\b/gi },
  { name: "a person by role", pattern: /\b(the owner|owner's)\b/gi },
  { name: "how the API is run", pattern: /\b(deploy\w*|roll(ed|s)? out|production (build|release))\b/gi },
  {
    name: "where secrets or settings are kept",
    pattern: /\b(org(anization)?|repo(sitory)?|actions|environment)[- ](level )?(secrets?|variables?)\b/gi,
  },
  {
    name: "a credential",
    pattern:
      /-----BEGIN [A-Z ]*PRIVATE KEY-----|\bgh[pousr]_[A-Za-z0-9]{30,}|\bgithub_pat_\w{20,}|\bnpm_[A-Za-z0-9]{36}\b|\bIv\d{1,2}[.a-zA-Z0-9]{14,}\b|\bsk_(live|test)_[A-Za-z0-9]{10,}|\bhaau3_sk_(live|test)_[A-Za-z0-9]{10,}|\bAIza[\w-]{35}|\bxox[abpr]-[\w-]{10,}/g,
  },
  {
    name: "an email address outside haau3's public ones",
    pattern: /[\w.+-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}\b/gi,
    allow: (match) => EMAIL_DOMAINS.test(match.slice(match.indexOf("@") + 1)),
  },
];

/** Files whose text is not this repository's own words. */
const NOT_OURS = [/^pnpm-lock\.yaml$/];
/** This check and its tests, which hold the patterns and their samples. */
const THE_CHECK = [/^scripts\/check-public-text\.ts$/, /^test\/public-text\.test\.ts$/];

export interface Finding {
  where: string;
  rule: string;
  match: string;
}

export function check(where: string, text: string, rules: Rule[] = RULES): Finding[] {
  const findings: Finding[] = [];
  const lines = text.split("\n");
  let offset = 0;
  for (const [i, line] of lines.entries()) {
    for (const rule of rules) {
      for (const m of line.matchAll(rule.pattern)) {
        if (rule.allow?.(m[0], text, offset + (m.index ?? 0))) continue;
        findings.push({ where: `${where}:${i + 1}`, rule: rule.name, match: m[0] });
      }
    }
    offset += line.length + 1;
  }
  return findings;
}

/** Rules from a file of one regular expression per line. */
export function termRules(source: string): Rule[] {
  return source
    .split("\n")
    .map((line) => line.replace(/(^|\s)#.*$/, "").trim())
    .filter(Boolean)
    .map((term) => ({ name: "a private term", pattern: new RegExp(term, "gi") }));
}

/** The git log range to read: `start..end`, or everything up to `end` when `start` does not exist yet. */
export function logRange(range: string, exists: (ref: string) => boolean): string {
  const [start, end] = range.split("..");
  if (end === undefined || !start) return range;
  return exists(start) ? range : end || "HEAD";
}

function refExists(ref: string): boolean {
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function main(args: string[]): number {
  const option = (name: string) => args.flatMap((arg, i) => (arg === name && args[i + 1] ? [args[i + 1]!] : []));
  const terms = option("--terms").flatMap((file) => termRules(readFileSync(file, "utf8")));
  const rules = [...RULES, ...terms];
  const findings: Finding[] = [];

  if (!args.includes("--no-files")) {
    const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
    for (const file of files) {
      if (NOT_OURS.some((p) => p.test(file))) continue;
      // The check's own patterns are left to the private terms alone.
      const fileRules = THE_CHECK.some((p) => p.test(file)) ? terms : rules;
      const text = readFileSync(file, "utf8");
      if (text.includes("\0")) continue;
      findings.push(...check(file, text, fileRules));
    }
  }
  for (const range of option("--commits")) {
    const log = execFileSync("git", ["log", "--format=%H%x1f%an%x1f%B%x1e", logRange(range, refExists)], { encoding: "utf8" });
    for (const entry of log.split("\x1e").map((e) => e.trim()).filter(Boolean)) {
      const [sha, author, message] = entry.split("\x1f");
      if (author === "dependabot[bot]") continue; // Its messages quote other projects' release notes.
      findings.push(...check(`commit ${sha!.slice(0, 7)}`, message ?? "", rules));
    }
  }
  for (const name of option("--text-env")) findings.push(...check(name, process.env[name] ?? "", rules));
  for (const file of option("--text-file")) findings.push(...check(file, readFileSync(file, "utf8"), rules));

  for (const f of findings) console.error(`${f.where}: ${f.rule}: ${f.match}`);
  console.error(findings.length ? `${findings.length} found.` : "Nothing found.");
  return findings.length ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = main(process.argv.slice(2));
