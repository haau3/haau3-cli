// Stand-ins for init's tests: package managers that record what they were asked and add the SDK to
// the manifest as the real ones do, and the docs, serving skill.md. Each stand-in is a launcher on a
// PATH of the test's own (a shell script, or a .cmd shim on Windows, as npm, pnpm and yarn install),
// which runs one Node script; nothing real is installed and no registry is called.
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join, relative } from "node:path";

const STAND_IN = `// A stand-in package manager: it records its name, arguments and folder, then does what the real
// one would to the manifest when it adds haau3's SDK.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const [name, ...args] = process.argv.slice(2);
appendFileSync(process.env.STANDIN_LOG, JSON.stringify({ name, args, cwd: process.cwd() }) + "\\n");
if (process.env.STANDIN_MODE === "fail") {
  process.stderr.write("the stand-in failed on purpose\\n");
  process.exit(3);
}
const cwd = process.cwd();
const lockfiles = { npm: "package-lock.json", pnpm: "pnpm-lock.yaml", yarn: "yarn.lock", bun: "bun.lock" };
if (name in lockfiles) {
  const manifest = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
  manifest.dependencies = { ...(manifest.dependencies ?? {}), "@haau3/sdk": "^0.4.4" };
  writeFileSync(join(cwd, "package.json"), JSON.stringify(manifest, null, 2) + "\\n");
  writeFileSync(join(cwd, lockfiles[name]), "lock\\n");
} else if (name === "uv" || name === "poetry") {
  const file = join(cwd, "pyproject.toml");
  writeFileSync(file, readFileSync(file, "utf8").replace("dependencies = []", 'dependencies = ["haau3>=0.4.4"]'));
  writeFileSync(join(cwd, name === "uv" ? "uv.lock" : "poetry.lock"), "lock\\n");
} else if (name === "pipenv") {
  appendFileSync(join(cwd, "Pipfile"), 'haau3 = "*"\\n');
  writeFileSync(join(cwd, "Pipfile.lock"), "{}\\n");
} else if (name === "go") {
  appendFileSync(join(cwd, "go.mod"), "\\nrequire github.com/haau3/haau3-go v0.3.3\\n");
  writeFileSync(join(cwd, "go.sum"), "sum\\n");
}
`;

export interface StandIns {
  /** The folder the launchers are in, for PATH. */
  bin: string;
  log: string;
  /** What each launcher was asked, in order. */
  calls(): { name: string; args: string[]; cwd: string }[];
}

/** Launchers for the managers named, in a folder outside any project. */
export function standIns(names: readonly string[]): StandIns {
  const root = mkdtempSync(join(tmpdir(), "cli-standin-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  const script = join(root, "standin.mjs");
  writeFileSync(script, STAND_IN);
  const log = join(root, "calls.log");
  writeFileSync(log, "");
  for (const name of names) {
    if (process.platform === "win32") {
      writeFileSync(join(bin, `${name}.cmd`), `@"${process.execPath}" "${script}" ${name} %*\r\n`);
    } else {
      const launcher = join(bin, name);
      writeFileSync(launcher, `#!/bin/sh\nexec "${process.execPath}" "${script}" ${name} "$@"\n`);
      chmodSync(launcher, 0o755);
    }
  }
  return {
    bin,
    log,
    calls: () =>
      readFileSync(log, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { name: string; args: string[]; cwd: string }),
  };
}

/** The docs' skill.md, as the docs serve it: frontmatter naming it haau3. */
export const SKILL = "---\nname: haau3\ndescription: Use when calling the haau3 platform API from code.\n---\n\n# haau3\n\nRun npx haau3 doctor --json first.\n";

export type DocsMode = "ok" | "redirect-same" | "redirect-away" | "missing" | "too-big" | "not-haau3" | "not-text";

/** A stand-in for docs.haau3.com on a local port. */
export class FakeDocs {
  mode: DocsMode = "ok";
  skill = SKILL;
  requests: { url: string; headers: Record<string, string | string[] | undefined> }[] = [];
  private server: Server | null = null;
  url = "";

  async start(): Promise<this> {
    this.server = createServer((req, res) => {
      this.requests.push({ url: req.url ?? "", headers: req.headers });
      if (this.mode === "redirect-same" && req.url === "/skill.md") {
        res.writeHead(302, { location: "/moved/skill.md" }).end();
        return;
      }
      if (this.mode === "redirect-away") {
        res.writeHead(302, { location: "https://elsewhere.example/skill.md" }).end();
        return;
      }
      const path = this.mode === "redirect-same" ? "/moved/skill.md" : "/skill.md";
      if (this.mode === "missing" || req.url !== path) {
        res.writeHead(404).end("not found");
        return;
      }
      const body =
        this.mode === "too-big"
          ? `${this.skill}${"x".repeat(300 * 1024)}`
          : this.mode === "not-haau3"
            ? this.skill.replace("name: haau3", "name: other")
            : this.skill;
      res.writeHead(200, { "content-type": "text/markdown; charset=utf-8" });
      res.end(this.mode === "not-text" ? Buffer.from([0xff, 0xfe, 0x00, 0x41]) : body);
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
    return this;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }
}

/** Every file under a folder, relative to it, node_modules left out. */
export function filesIn(folder: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (at: string) => {
    for (const name of readdirSync(at)) {
      if (name === "node_modules" || name === ".git") continue;
      const path = join(at, name);
      if (statSync(path).isDirectory()) walk(path);
      else out.set(relative(folder, path).split("\\").join("/"), readFileSync(path, "utf8"));
    }
  };
  walk(folder);
  return out;
}

/** A PATH of these folders. */
export function pathOf(...folders: string[]): string {
  return folders.join(delimiter);
}
