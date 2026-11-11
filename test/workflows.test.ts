// The workflows: what npm's trusted publisher depends on, what CI proves on each system, and what
// keeps haau3-bot's token honest.
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const dir = new URL("../.github/workflows/", import.meta.url);
const workflow = (name: string) => parse(readFileSync(new URL(name, dir), "utf8")) as Record<string, any>;
const release = workflow("release.yml");
const ci = workflow("ci.yml");

describe("release.yml", () => {
  it("runs on a push to main and on nothing else, so a version is staged once", () => {
    expect(release.on).toEqual({ push: { branches: ["main"] } });
  });

  it("stages only a release release-please reports it made, at its tag", () => {
    const stage = release.jobs.stage;
    expect(stage.needs).toBe("release");
    expect(stage.if).toContain("needs.release.outputs.release_created == 'true'");
    expect(release.jobs.release.outputs.release_created).toBe("${{ steps.release.outputs.release_created }}");
    expect(stage.steps[0].with.ref).toBe("${{ needs.release.outputs.tag_name }}");
  });

  it("stages in the npm environment, the one npm's trusted publisher names, with the OIDC token there alone", () => {
    expect(release.jobs.stage.environment).toBe("npm");
    expect(release.jobs.stage.permissions).toEqual({ contents: "read", "id-token": "write" });
    expect(release.jobs.release.permissions).toBeUndefined();
    expect(release.permissions).toEqual({ contents: "read" });
  });

  it("tests, builds and runs the packed package before it stages, and stages rather than publishes", () => {
    const run = release.jobs.stage.steps.map((s: any) => s.run).filter(Boolean) as string[];
    const at = (command: string) => run.indexOf(command);
    const stage = at("npm stage publish --access public");
    expect(stage).toBe(run.length - 1);
    for (const command of ["pnpm typecheck", "pnpm test", "pnpm build", "pnpm check:package", "pnpm check:bin"]) {
      expect(at(command), command).toBeGreaterThan(-1);
      expect(at(command), command).toBeLessThan(stage);
    }
    expect(run.some((r) => /npm publish(?! )|npm publish --/.test(r))).toBe(false);
  });

  it("gives release-please haau3-bot's token and the repository's config", () => {
    const steps = release.jobs.release.steps;
    const please = steps.find((s: any) => String(s.uses).startsWith("googleapis/release-please-action@"));
    expect(please.with).toEqual({
      token: "${{ steps.token.outputs.token }}",
      "config-file": "release-please-config.json",
      "manifest-file": ".release-please-manifest.json",
    });
  });
});

describe("ci.yml", () => {
  it("tests on Node 22, 24 and 26, on Linux, macOS and Windows, every combination", () => {
    expect(ci.jobs.test.strategy.matrix).toEqual({
      node: ["22", "24", "26"],
      os: ["ubuntu-latest", "macos-latest", "windows-latest"],
    });
    expect(ci.jobs.test.strategy["fail-fast"]).toBe(false);
    expect(ci.jobs.test["runs-on"]).toBe("${{ matrix.os }}");
  });

  it("runs the packed package on each system after the tests", () => {
    const run = ci.jobs.test.steps.filter((s: any) => s.run && !s.if).map((s: any) => s.run);
    expect(run).toEqual(["pnpm install --frozen-lockfile", "pnpm test", "pnpm build", "pnpm check:bin"]);
  });

  it("tests the session store against each system's own credential store, a keyring started first on Linux", () => {
    expect(ci.jobs.test.env).toEqual({ HAAU3_TEST_OS_STORE: "1" });
    const steps = ci.jobs.test.steps;
    const keyring = steps.findIndex((s: any) => s.if === "runner.os == 'Linux'");
    expect(keyring).toBeGreaterThan(-1);
    // An empty password makes no login keyring, so no default collection, and every write fails.
    expect(steps[keyring].run).toMatch(/printf '[^']+' \| gnome-keyring-daemon .*--unlock/);
    expect(steps[keyring].run).toContain('>> "$GITHUB_ENV"');
    expect(keyring).toBeLessThan(steps.findIndex((s: any) => s.run === "pnpm test"));
    expect(steps.filter((s: any) => s.if)).toHaveLength(1);
  });

  it("checks types, lint and the package once", () => {
    const run = ci.jobs.checks.steps.map((s: any) => s.run).filter(Boolean);
    expect(run).toEqual(["pnpm install --frozen-lockfile", "pnpm typecheck", "pnpm lint", "pnpm build", "pnpm check:package"]);
  });
});

describe("public-text.yml", () => {
  const publicText = workflow("public-text.yml");
  const run = publicText.jobs.check.steps.at(-1).run as string;

  it("runs on every pull request to main, again when its title or description is edited", () => {
    expect(publicText.on.pull_request.branches).toEqual(["main"]);
    expect(publicText.on.pull_request.types).toEqual(expect.arrayContaining(["opened", "edited", "synchronize"]));
    // pull_request, never pull_request_target: a fork's pull request gets no write token.
    expect(Object.keys(publicText.on)).toEqual(["pull_request"]);
  });

  it("checks the files, the commits the PR brings, and its title and description", () => {
    expect(run).toContain('--commits "$BASE..$HEAD" --text-env PR_TITLE --text-env PR_BODY');
    // The title and description reach the script as variables, never as text in the script.
    expect(run).not.toContain("github.event");
  });
});

describe("every workflow", () => {
  const files = readdirSync(dir).filter((name) => name.endsWith(".yml"));

  it("is one of the three this repository runs", () => {
    expect(files.sort()).toEqual(["ci.yml", "public-text.yml", "release.yml"]);
  });

  it("asks for no more than read access to the repository, except the job that stages", () => {
    for (const name of files) {
      expect(workflow(name).permissions, name).toEqual({ contents: "read" });
    }
  });

  it("calls fromJSON in no step's env, which GitHub evaluates even when the step's if is false", () => {
    for (const name of files) {
      const jobs = Object.values(workflow(name).jobs) as { steps: { name?: string; env?: Record<string, string> }[] }[];
      for (const step of jobs.flatMap((job) => job.steps)) {
        for (const value of Object.values(step.env ?? {})) {
          expect(String(value), `${name}: ${step.name}`).not.toMatch(/fromJSON\(/i);
        }
      }
    }
  });

  it("pins every action it uses by commit", () => {
    for (const name of files) {
      const jobs = Object.values(workflow(name).jobs) as { steps: { uses?: string }[] }[];
      for (const uses of jobs.flatMap((job) => job.steps.map((s) => s.uses).filter(Boolean))) {
        expect(uses, `${name}: ${uses}`).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/);
      }
    }
  });
});
