// scripts/check-public-text.ts finds each kind of text this repository never publishes, and allows
// the shapes its own text uses. The samples are made up.
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { check, logRange, termRules } from "../scripts/check-public-text.js";

const found = (text: string) => check("sample", text).map((f) => f.match);

describe("the public-text check", () => {
  it.each([
    ["another repository of the organization", "see haau3/private-thing for why", "haau3/private-thing"],
    ["a project or service name", "it runs in haau3-example-project", "haau3-example-project"],
    ["a bare issue number", "decided in issue #123", "#123"],
    ["an issue number without a #", "see issue 123", "issue 123"],
    ["a work-item id", "this is ABC-4", "ABC-4"],
    ["a planning word", "part of the milestone", "milestone"],
    ["a person by role", "the owner approves it", "the owner"],
    ["how the API is run", "after each deploy", "deploy"],
    ["where secrets are kept", "the key is an org secret", "org secret"],
    ["a credential", "Iv23liEXAMPLEexample00", "Iv23liEXAMPLEexample00"],
    ["a haau3 key", `use ${["haau3", "sk", "live", "0123456789abcdef"].join("_")}`, ["haau3", "sk", "live", "0123456789abcdef"].join("_")],
    ["a private email address", "write to someone@personal.example-mail.net", "someone@personal.example-mail.net"],
  ])("finds %s", (_, text, match) => {
    expect(found(text)).toContain(match);
  });

  it("allows what this repository's own text uses", () => {
    const text = [
      "npx haau3 --version, from haau3/haau3-cli#3, opened by haau3-bot[bot] as haau3-cli/0.1.0.",
      "The SDKs: @haau3/sdk from haau3/haau3-node, haau3 on PyPI from haau3/haau3-python, and haau3-go.",
      "PHQ-9 and UTF-8, ICD-10-CM, googleapis/release-please-action#1203 and pnpm@12.12.1.",
      "* the first version ([#5](https://github.com/haau3/haau3-cli/issues/5))",
      "Write to hello@haau3.com. Co-Authored-By: Claude <noreply@anthropic.com>",
      "A key's prefix is haau3_sk_live_ or haau3_sk_test_.",
      "init writes .claude/skills/haau3/SKILL.md and .agents/skills/haau3/SKILL.md.",
    ].join("\n");
    expect(found(text)).toEqual([]);
  });

  it("still finds another repository named in a link or after a path", () => {
    expect(found("https://github.com/haau3/private-thing")).toEqual(["haau3/private-thing"]);
    expect(found("the skills of haau3/private-thing")).toEqual(["haau3/private-thing"]);
  });

  it("allows a changelog link only to this repository", () => {
    expect(found("([#5](https://github.com/haau3/haau3-cli/issues/5))")).toEqual([]);
    expect(found("([#5](https://github.com/haau3/haau3-node/issues/5))")).toEqual(["#5"]);
  });

  it("takes extra terms from a file of patterns, with comments", () => {
    const rules = termRules("# a comment\nsecret-codename\n\n  other\\d+  # trailing comment\n");
    expect(rules.map((r) => r.pattern.source)).toEqual(["secret-codename", "other\\d+"]);
    expect(check("sample", "the Secret-Codename and other42", rules).map((f) => f.match)).toEqual(["Secret-Codename", "other42"]);
  });

  it("reads every commit when a range starts at a branch that does not exist yet, as before a first push", () => {
    expect(logRange("origin/main..HEAD", () => true)).toBe("origin/main..HEAD");
    expect(logRange("origin/main..HEAD", () => false)).toBe("HEAD");
    expect(logRange("abc123..def456", () => false)).toBe("def456");
    expect(logRange("HEAD", () => false)).toBe("HEAD");
  });

  it("passes this repository's own files", () => {
    // The real run, as CI and a pull request use it: it fails on any finding.
    const run = () => execFileSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", "scripts/check-public-text.ts"], { stdio: "pipe" });
    expect(run).not.toThrow();
  });

  it("fails on a finding when run (the control)", () => {
    const run = () =>
      execFileSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", "scripts/check-public-text.ts", "--no-files", "--text-env", "SAMPLE"], {
        stdio: "pipe",
        env: { ...process.env, SAMPLE: "planned in the milestone" },
      });
    expect(run).toThrow();
  });
});
