// Packs the package as npm publishes it, installs the tarball into a new project, and runs the command
// line from there the way `npx haau3` does, on whatever operating system this runs on. Run after
// `pnpm build`.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const work = join(root, ".check-bin");
const windows = process.platform === "win32";
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string };

rmSync(work, { recursive: true, force: true });
mkdirSync(join(work, "project"), { recursive: true });

const npm = (args: string[], cwd: string) => execFileSync("npm", args, { cwd, encoding: "utf8", shell: windows });
const packed = JSON.parse(npm(["pack", "--json", "--pack-destination", work], root)) as { filename: string; files: { path: string }[] }[];
const tarball = join(work, packed[0]!.filename);
const files = packed[0]!.files.map((f) => f.path).sort();

writeFileSync(join(work, "project", "package.json"), JSON.stringify({ name: "check-bin", private: true }));
npm(["install", tarball, "--no-audit", "--no-fund", "--ignore-scripts"], join(work, "project"));

function haau3(...args: string[]) {
  const result = spawnSync("npm", ["exec", "--no", "--", "haau3", ...args], {
    cwd: join(work, "project"),
    encoding: "utf8",
    shell: windows,
    env: { ...process.env, HAAU3_OUTPUT: "" },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const failures: string[] = [];
const expect = (ok: boolean, what: string) => {
  if (!ok) failures.push(what);
};

// npm adds package.json, the README, the license and possibly the changelog by itself; the rest is
// what `files` says.
const ours = files.filter((f) => !/^(package\.json|README\.md|LICENSE|CHANGELOG\.md)$/.test(f));
expect(JSON.stringify(ours) === JSON.stringify(["dist/cli.mjs"]), `the tarball holds ${files.join(", ")}`);

const version = haau3("--version");
expect(version.status === 0 && version.stdout === `${pkg.version}\n`, `--version printed ${JSON.stringify(version.stdout)}, exit ${version.status}`);

const help = haau3("--help");
expect(help.status === 0 && help.stdout.includes("Usage: haau3"), `--help printed ${JSON.stringify(help.stdout.slice(0, 80))}, exit ${help.status}`);

// Not a terminal here, so an unknown command answers as one JSON document.
const unknown = haau3("no-such-command");
let document: any;
try {
  document = JSON.parse(unknown.stdout);
} catch {
  document = null;
}
expect(unknown.status === 2, `an unknown command exited ${unknown.status}`);
expect(document?.formatVersion === "1.0" && document?.error?.code === "unknown-command", `an unknown command printed ${JSON.stringify(unknown.stdout.slice(0, 120))}`);

rmSync(work, { recursive: true, force: true });
for (const f of failures) console.error(f);
console.error(failures.length ? `${failures.length} failed.` : `The packed package runs: haau3 ${pkg.version}.`);
process.exitCode = failures.length ? 1 : 0;
