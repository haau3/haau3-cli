// The env file a key goes to, and the edit: every byte that is not the key's line stays as it was,
// whatever the file holds (comments, quotes, `export`, Windows line endings, a byte-order mark, no
// last line break), and an edit Node's own parser would read differently is never made.
import { linkSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chooseFile, inspectFile, planEdit, planFor, shownPrefix, writeKey } from "../src/envfile.js";
import { ApiKey } from "../src/key.js";

/** Built from parts, so no file in this repository holds a whole key-shaped string. */
const key = (mode: "live" | "test", body: string) => ["haau3", "sk", mode, body].join("_");
const NEW = key("live", `New456${"n".repeat(30)}`);
const OLD = key("live", `Old789${"o".repeat(30)}`);

let project: string;
beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), "cli-envfile-"));
});
afterEach(() => rmSync(project, { recursive: true, force: true }));

/** Applies an edit the way writeKey does, to see the file it makes. */
function applied(content: string | null, value = NEW): string | null {
  const edit = planEdit(content, value);
  if (!edit) return null;
  return edit.kind === "append" ? (content ?? "") + edit.text : edit.text;
}

describe("the edit", () => {
  it("creates a file holding the key alone", () => {
    expect(applied(null)).toBe(`HAAU3_API_KEY=${NEW}\n`);
  });

  it("appends to a file with no key, leaving every earlier byte as it was", () => {
    const file = `# Database\nDATABASE_URL="postgres://u:p@h/db?x=1"\nexport NODE_ENV=production\nQUOTED='a b'\n\n`;
    expect(planEdit(file, NEW)?.kind).toBe("append");
    expect(applied(file)).toBe(`${file}HAAU3_API_KEY=${NEW}\n`);
  });

  it("adds a line break first when the file has no last one", () => {
    expect(applied("A=1")).toBe(`A=1\nHAAU3_API_KEY=${NEW}\n`);
    expect(applied("")).toBe(`HAAU3_API_KEY=${NEW}\n`);
  });

  it("keeps Windows line endings", () => {
    const file = "A=1\r\nB=\"two\"\r\n# note\r\n";
    expect(applied(file)).toBe(`${file}HAAU3_API_KEY=${NEW}\r\n`);
    expect(applied("A=1\r\nB=2")).toBe(`A=1\r\nB=2\r\nHAAU3_API_KEY=${NEW}\r\n`);
    expect(applied(`A=1\r\nHAAU3_API_KEY=${OLD}\r\nB=2\r\n`)).toBe(`A=1\r\nHAAU3_API_KEY=${NEW}\r\nB=2\r\n`);
  });

  it("keeps a byte-order mark", () => {
    expect(applied("\uFEFFA=1\n")).toBe(`\uFEFFA=1\nHAAU3_API_KEY=${NEW}\n`);
    expect(applied(`\uFEFFHAAU3_API_KEY=${OLD}\nA=1\n`)).toBe(`\uFEFFHAAU3_API_KEY=${NEW}\nA=1\n`);
  });

  it("replaces the key's line where it is, keeping `export` and indentation, and removes repeats", () => {
    const file = `A=1\n  export HAAU3_API_KEY=${OLD}\nB=2\nHAAU3_API_KEY=${OLD}\n# end\n`;
    expect(planEdit(file, NEW)?.kind).toBe("rewrite");
    expect(applied(file)).toBe(`A=1\n  export HAAU3_API_KEY=${NEW}\nB=2\n# end\n`);
    expect(applied(`HAAU3_API_KEY = ${OLD}`)).toBe(`HAAU3_API_KEY=${NEW}`);
  });

  it("reads back as the file with only the key changed, by Node's own parser", () => {
    const file = `X="multi\nline"\nY=y # comment\nHAAU3_API_KEY=${OLD}\nZ='z'\n`;
    const after = applied(file)!;
    const [was, now] = [parseEnv(file), parseEnv(after)];
    expect(now.HAAU3_API_KEY).toBe(NEW);
    expect({ ...now, HAAU3_API_KEY: undefined }).toEqual({ ...was, HAAU3_API_KEY: undefined });
  });

  it("makes no edit that would change another variable", () => {
    // The key's line sits inside another variable's quoted value: replacing it would change that value.
    const file = `CERT="begin\nHAAU3_API_KEY=${OLD}\nend"\n`;
    expect(planEdit(file, NEW)).toBeNull();
  });

  it("does not edit a file that ends lines with a carriage return alone", () => {
    // Node's parser drops every CR, so it would read this as one line; dotenv reads three variables.
    expect(planEdit(`HAAU3_API_KEY=${OLD}\rA=1\rB=2`, NEW)).toBeNull();
    expect(planEdit("A=1\rB=2\r", NEW)).toBeNull();
  });
});

describe("the prefix of a key in the file", () => {
  it("is what the keys page shows, and only for a well-formed key", () => {
    expect(shownPrefix(OLD)).toBe("haau3_sk_live_Old789");
    expect(shownPrefix("not-a-key")).toBeNull();
    expect(shownPrefix(key("live", "short"))).toBeNull();
    expect(shownPrefix(`${OLD}\nX=1`)).toBeNull();
  });
});

describe("choosing the file", () => {
  const choose = (file?: string) => {
    const result = chooseFile({ cwd: project, file, env: {} });
    if (!result.ok) throw new Error(result.error.code);
    return result.chosen;
  };

  it("takes .env for a project with none, and .env.local for Next.js or Vite", () => {
    expect(choose()).toMatchObject({ shown: ".env", reason: "default" });
    writeFileSync(join(project, "package.json"), JSON.stringify({ dependencies: { next: "16" } }));
    expect(choose()).toMatchObject({ shown: ".env.local", reason: "framework" });
    writeFileSync(join(project, "package.json"), "{ not json");
    expect(choose()).toMatchObject({ shown: ".env" });
  });

  it("takes the file the project has, .env.local first", () => {
    writeFileSync(join(project, ".env"), "A=1\n");
    expect(choose()).toMatchObject({ shown: ".env", reason: "existing" });
    writeFileSync(join(project, ".env.local"), "B=1\n");
    expect(choose()).toMatchObject({ shown: ".env.local", reason: "existing" });
  });

  it("takes the file that holds the key, whichever it is", () => {
    writeFileSync(join(project, ".env.local"), "B=1\n");
    writeFileSync(join(project, ".env"), `HAAU3_API_KEY=${OLD}\n`);
    expect(choose()).toMatchObject({ shown: ".env", reason: "holds-key" });
  });

  it("takes the named file, by an env file's name only", () => {
    expect(choose(".env.production")).toMatchObject({ shown: ".env.production", reason: "named" });
    expect(choose("config/prod.env")).toMatchObject({ shown: join("config", "prod.env") });
    expect(choose("my settings/.env")).toMatchObject({ shown: join("my settings", ".env") });
    // Nothing a shell or a terminal acts on: the path is printed in commands an agent may run.
    const shell = ["prod$(id).env", "a;id.env", "a`id`.env", "a|b.env", "a&b.env", "it's.env", 'a"b.env', "a>b.env"];
    for (const bad of ["package.json", "env", "my.envrc.json", `${OLD}.env`, "x\u0007.env", "x\u202E.env", ...shell]) {
      const result = chooseFile({ cwd: project, file: bad, env: {} });
      expect(result.ok ? null : result.error.code).toBe("invalid-file");
    }
  });
});

describe("the write", () => {
  const target = (name: string) => {
    const result = inspectFile({ path: join(project, name), shown: name, reason: "existing" });
    if (!result.ok) throw new Error(result.error.code);
    return result.target;
  };

  it("creates a new file only when none appeared meanwhile", () => {
    const fresh = target(".env");
    writeFileSync(join(project, ".env"), "SOMEONE=else\n");
    const result = writeKey(fresh, new ApiKey(NEW), false);
    expect(result.ok).toBe(false);
    expect(readFileSync(join(project, ".env"), "utf8")).toBe("SOMEONE=else\n");
  });

  it("appends to the file as it is now, not as it was", () => {
    writeFileSync(join(project, ".env"), "A=1\n");
    const checked = target(".env");
    writeFileSync(join(project, ".env"), "A=1\nB=2\n");
    expect(writeKey(checked, new ApiKey(NEW), false)).toEqual({ ok: true, created: false });
    expect(readFileSync(join(project, ".env"), "utf8")).toBe(`A=1\nB=2\nHAAU3_API_KEY=${NEW}\n`);
  });

  it("rewrites in place with --replace, and shortens the file when the key's line got shorter", () => {
    const long = key("live", `Old789${"o".repeat(150)}`);
    writeFileSync(join(project, ".env"), `HAAU3_API_KEY=${long}\nA=1\n`);
    expect(writeKey(target(".env"), new ApiKey(NEW), true)).toEqual({ ok: true, created: false });
    expect(readFileSync(join(project, ".env"), "utf8")).toBe(`HAAU3_API_KEY=${NEW}\nA=1\n`);
  });

  it("appends after a file's last byte even when it is not UTF-8, and never rewrites such a file", () => {
    // "café" in Latin-1: one byte, E9, that is not UTF-8.
    const latin1 = Buffer.concat([Buffer.from("# caf"), Buffer.from([0xe9]), Buffer.from("\nA=1\n")]);
    writeFileSync(join(project, ".env"), latin1);
    expect(writeKey(target(".env"), new ApiKey(NEW), false)).toEqual({ ok: true, created: false });
    expect(readFileSync(join(project, ".env")).equals(Buffer.concat([latin1, Buffer.from(`HAAU3_API_KEY=${NEW}\n`)]))).toBe(true);

    const withKey = Buffer.concat([latin1, Buffer.from(`HAAU3_API_KEY=${OLD}\n`)]);
    writeFileSync(join(project, ".env"), withKey);
    const checked = target(".env");
    expect(checked.utf8).toBe(false);
    expect(planFor(checked, NEW)).toBeNull();
    expect(writeKey(checked, new ApiKey(NEW), true).ok).toBe(false);
    expect(readFileSync(join(project, ".env")).equals(withKey)).toBe(true);
  });

  it("writes nothing that is not of a key's shape", () => {
    const result = writeKey(target(".env"), new ApiKey(`${NEW}\nEVIL=1`), false);
    expect(result.ok).toBe(false);
  });
});

describe("files a key is never written to", () => {
  const refusal = (name: string) => {
    const result = inspectFile({ path: join(project, name), shown: name, reason: "existing" });
    return result.ok ? null : result.error.code;
  };

  it("refuses a file that is not text, such as UTF-16, which Windows PowerShell 5 writes", () => {
    writeFileSync(join(project, ".env"), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("A=1\n", "utf16le")]));
    expect(refusal(".env")).toBe("env-file-not-text");
  });

  it("refuses a file with another name, a hard link, one of which git could keep", () => {
    writeFileSync(join(project, "tracked.env"), "A=1\n");
    linkSync(join(project, "tracked.env"), join(project, ".env"));
    expect(refusal(".env")).toBe("env-file-hard-link");
  });
});
