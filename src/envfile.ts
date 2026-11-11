// Where `haau3 keys create` writes the key, and how, so that the env file is the only file it changes
// and everything else in it is left exactly as it was.
//
// The file is the one named with --env-file; else whichever of .env.local and .env already holds
// HAAU3_API_KEY, in the order the key finder reads them; else .env.local if it exists, then .env;
// else a new one: .env.local for a project on Next.js or Vite, whose loaders read it, and .env for
// everything else, which is the file Node's loadEnvFile(), python-dotenv, godotenv and Deno read.
//
// The edit is planned and checked before the platform is asked for a key: read back with Node's own
// parser, the variable must hold the new value and every other variable must read as it did. The
// write never makes a temporary file, so the key is never in a second file: a new file is created
// exclusively and readable only by its owner, a key goes on the end of a file that has none, and
// --replace rewrites the file in place.
import { accessSync, closeSync, constants, fstatSync, ftruncateSync, lstatSync, openSync, readFileSync, statSync, writeSync, type Stats } from "node:fs";
import { isUtf8 } from "node:buffer";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, relative, resolve } from "node:path";
import { parseEnv } from "node:util";
import { sameFolder } from "./git.js";
import { KEY_FILES, KEY_VARIABLE, modeOf, type ApiKey } from "./key.js";
import type { CliError } from "./output.js";

/** An env file bigger than this is not one: it is neither read nor written. The key finder's limit. */
export const MAX_ENV_FILE_BYTES = 1024 * 1024;

/** What a key's prefix shows on the keys page: the mode's prefix and the first six characters after it. */
const SHOWN_RANDOM = 6;

/** The characters a key is made of after its prefix. */
const KEY_BODY = /^haau3_sk_(?:live|test)_[A-Za-z0-9_-]{20,200}$/;

/** An env file's name, as --env-file must give it: .env, .env.local, .env.production, prod.env. */
const ENV_FILE_NAME = /(^\.env)|(\.env$)/;

/** A key's marker anywhere: a value holding it was a key pasted in the wrong place. */
const KEY_MARKER = /haau3_sk_/i;

/** Characters a terminal can act on, or that change how text reads without showing. */
const UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/** A line that sets the variable: optional indent, optional `export`, the name, then `=`. */
const DEFINITION = /^(\uFEFF?[ \t]*(?:export[ \t]+)?)HAAU3_API_KEY[ \t]*=/;

export type Reason = "named" | "holds-key" | "existing" | "framework" | "default";

export interface Chosen {
  /** The absolute path. */
  path: string;
  /** How it is printed: relative to the current folder when inside it, else absolute. */
  shown: string;
  reason: Reason;
}

export type ChooseResult = { ok: true; chosen: Chosen } | { ok: false; usage: boolean; error: CliError };

export interface Target extends Chosen {
  /** The file's text, or null when it does not exist yet. */
  content: string | null;
  /** Whether the file is UTF-8 text, which a rewrite needs. An append leaves every byte alone. */
  utf8: boolean;
  /** The key the file holds now, when it holds one that is not blank. */
  existing: { prefix: string | null } | null;
}

export type InspectResult = { ok: true; target: Target } | { ok: false; error: CliError };

/** The path as a person reads it, relative to the current folder when it is inside it. */
export function shownPath(path: string, cwd: string): string {
  const rel = relative(resolve(cwd), path);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : path;
}

function homeOf(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  const configured = platform === "win32" ? env.USERPROFILE : env.HOME;
  return configured?.trim() ? configured : homedir();
}

/** The variable's value in an env file's text, read as Node reads it. */
function valueIn(text: string): string | undefined {
  return parseEnv(stripBom(text))[KEY_VARIABLE];
}

function stripBom(text: string): string {
  return text.startsWith("\uFEFF") ? text.slice(1) : text;
}

function readIfFile(path: string): string | null {
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > MAX_ENV_FILE_BYTES) return null;
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Whether the folder's package.json depends on Next.js or Vite, whose loaders read .env.local. */
export function readsEnvLocal(folder: string): boolean {
  const text = readIfFile(join(folder, "package.json"));
  if (text === null) return false;
  try {
    const manifest = JSON.parse(text) as Record<string, unknown>;
    return ["dependencies", "devDependencies"].some((field) => {
      const deps = manifest[field];
      return typeof deps === "object" && deps !== null && ("next" in deps || "vite" in deps);
    });
  } catch {
    return false;
  }
}

/** Which file to write, by the rules at the top of this file, or why none can be chosen. */
export function chooseFile({
  cwd,
  envFile,
  env,
  platform = process.platform,
}: {
  cwd: string;
  envFile: string | undefined;
  env: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}): ChooseResult {
  if (envFile !== undefined) {
    // Checked before anything repeats it: only an env file's name, and never a key.
    const name = basename(envFile);
    if (envFile.length > 1024 || KEY_MARKER.test(envFile) || UNSAFE.test(envFile) || !ENV_FILE_NAME.test(name)) {
      return {
        ok: false,
        usage: true,
        error: {
          code: "invalid-env-file",
          message: "--env-file must name an env file: a file whose name starts or ends with .env, such as .env.local or prod.env.",
          next: [{ command: "npx haau3 keys create", description: "Write to the project's own env file instead." }],
        },
      };
    }
    const path = resolve(cwd, envFile);
    return { ok: true, chosen: { path, shown: shownPath(path, cwd), reason: "named" } };
  }

  const folder = resolve(cwd);
  if (sameFolder(folder, homeOf(env, platform), platform) || parse(folder).root === folder) {
    return {
      ok: false,
      usage: true,
      error: {
        code: "not-a-project",
        message: "haau3 keys create writes to the env file of the folder it runs in, and this is your home folder or a drive's root. Run it in your project's folder.",
        next: [],
      },
    };
  }

  const at = (name: string): Chosen => {
    const path = join(folder, name);
    return { path, shown: name, reason: "existing" };
  };
  for (const name of KEY_FILES) {
    const value = readIfFile(join(folder, name));
    if (value !== null && present(valueIn(value))) return { ok: true, chosen: { ...at(name), reason: "holds-key" } };
  }
  for (const name of KEY_FILES) {
    if (exists(join(folder, name))) return { ok: true, chosen: at(name) };
  }
  const local = readsEnvLocal(folder);
  const name = local ? ".env.local" : ".env";
  return { ok: true, chosen: { path: join(folder, name), shown: name, reason: local ? "framework" : "default" } };
}

function present(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== "";
}

/** The part of a key the keys page shows, or null when the value is not a well-formed haau3 key. */
export function shownPrefix(value: string): string | null {
  const mode = modeOf(value);
  if (mode === "unrecognized" || !KEY_BODY.test(value)) return null;
  return value.slice(0, `haau3_sk_${mode}_`.length + SHOWN_RANDOM);
}

function refuse(code: string, message: string): InspectResult {
  return { ok: false, error: { code, message, next: [] } };
}

/** Checks the chosen file can be written, and reads it. Nothing is written here. */
export function inspectFile(chosen: Chosen): InspectResult {
  const { shown } = chosen;
  let stat: Stats;
  try {
    stat = lstatSync(chosen.path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return refuse("env-file-unreadable", `haau3 could not look at ${shown}.`);
    const folder = dirname(chosen.path);
    try {
      if (!statSync(folder).isDirectory()) return refuse("env-file-folder-missing", `The folder for ${shown} does not exist.`);
      accessSync(folder, constants.W_OK);
    } catch (folderError) {
      const missing = (folderError as NodeJS.ErrnoException).code === "ENOENT";
      return missing
        ? refuse("env-file-folder-missing", `The folder for ${shown} does not exist.`)
        : refuse("env-file-not-writable", `haau3 cannot create ${shown}: its folder cannot be written to.`);
    }
    return { ok: true, target: { ...chosen, content: null, utf8: true, existing: null } };
  }

  if (stat.isSymbolicLink()) {
    return refuse("env-file-symlink", `${shown} is a symbolic link. haau3 writes a key only to a file itself, since a link can lead to a file that git keeps. Replace the link with the file, or name the file with --env-file.`);
  }
  if (!stat.isFile()) return refuse("env-file-not-a-file", `${shown} is not a file.`);
  if (stat.size > MAX_ENV_FILE_BYTES) return refuse("env-file-too-large", `${shown} is larger than an env file should be (1 MiB), so haau3 leaves it alone.`);
  let bytes: Buffer;
  try {
    bytes = readFileSync(chosen.path);
    accessSync(chosen.path, constants.W_OK);
  } catch {
    return refuse("env-file-not-writable", `haau3 cannot read and write ${shown}.`);
  }
  const content = bytes.toString("utf8");
  const value = valueIn(content);
  const existing = present(value) ? { prefix: shownPrefix(value.trim()) } : null;
  return { ok: true, target: { ...chosen, content, utf8: isUtf8(bytes), existing } };
}

/** The edit for this file, or null when there is none that is safe: planEdit's, and a rewrite only of UTF-8 text. */
export function planFor(target: Target, value: string): Edit | null {
  const edit = planEdit(target.content, value);
  return edit && (edit.kind !== "rewrite" || target.utf8) ? edit : null;
}

export type Edit =
  /** A new file, holding the key alone. */
  | { kind: "create"; text: string }
  /** The file had no key: this goes on its end, and nothing before it changes. */
  | { kind: "append"; text: string }
  /** The file had the variable: the whole file as it becomes. */
  | { kind: "rewrite"; text: string };

/**
 * The edit that puts `value` in the file, or null when Node's own parser would not read the result as
 * the file with only the variable changed. A line that sets it (with or without `export`) is replaced
 * where it is and any later one removed; otherwise one line goes on the end, in the file's own line
 * ending, after a line break when the file has no last one.
 */
export function planEdit(content: string | null, value: string): Edit | null {
  const line = `${KEY_VARIABLE}=${value}`;
  if (content === null) return { kind: "create", text: `${line}\n` };

  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content.split(/(?<=\n)/);
  const found = lines.findIndex((l) => DEFINITION.test(l));
  let edit: Edit;
  if (found === -1) {
    const lead = content === "" || content.endsWith("\n") ? "" : eol;
    edit = { kind: "append", text: `${lead}${line}${eol}` };
  } else {
    const out: string[] = [];
    lines.forEach((l, i) => {
      if (i === found) {
        const ending = l.endsWith("\r\n") ? "\r\n" : l.endsWith("\n") ? "\n" : "";
        out.push(`${DEFINITION.exec(l)![1]}${line}${ending}`);
      } else if (i < found || !DEFINITION.test(l)) {
        out.push(l);
      }
    });
    edit = { kind: "rewrite", text: out.join("") };
  }

  const after = edit.kind === "append" ? content + edit.text : edit.text;
  return readsAsOnlyTheKey(content, after, value) ? edit : null;
}

/** Whether `after` reads as `before` with only the variable changed, to `value`. */
function readsAsOnlyTheKey(before: string, after: string, value: string): boolean {
  const was = parseEnv(stripBom(before));
  const now = parseEnv(stripBom(after));
  if (now[KEY_VARIABLE] !== value) return false;
  const names = new Set([...Object.keys(was), ...Object.keys(now)]);
  names.delete(KEY_VARIABLE);
  for (const name of names) if (was[name] !== now[name]) return false;
  return true;
}

/** A value of a key's shape and length, to plan and check the edit before a key exists. */
export function standIn(mode: "live" | "test"): string {
  return `haau3_sk_${mode}_${"x".repeat(43)}`;
}

export type WriteResult = { ok: true; created: boolean } | { ok: false; reason: string };

/**
 * Writes the key. The file is read again first and the edit planned again on what it holds now, so a
 * change since the checks is never overwritten: a file that appeared, vanished, became a link, or
 * gained a key, stops the write.
 */
export function writeKey(target: Target, key: ApiKey, replace: boolean): WriteResult {
  const value = key.reveal();
  if (!KEY_BODY.test(value)) return { ok: false, reason: "the key is not of a key's shape" };
  const noFollow = constants.O_NOFOLLOW ?? 0;

  if (target.content === null) {
    const edit = planEdit(null, value)!;
    let fd: number | undefined;
    try {
      fd = openSync(target.path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600);
      writeAll(fd, edit.text);
      return { ok: true, created: true };
    } catch (error) {
      return { ok: false, reason: errorCode(error, "the file could not be created") };
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  let fd: number | undefined;
  try {
    fd = openSync(target.path, constants.O_RDWR | noFollow);
    if (!fstatSync(fd).isFile()) return { ok: false, reason: "it is no longer a file" };
    const now = lstatSync(target.path);
    if (now.isSymbolicLink()) return { ok: false, reason: "it is now a symbolic link" };
    const bytes = readFileSync(fd);
    const content = bytes.toString("utf8");
    if (!replace && present(valueIn(content))) return { ok: false, reason: "a key was written to it meanwhile" };
    const edit = planEdit(content, value);
    if (!edit) return { ok: false, reason: "it changed meanwhile, and the edit no longer reads back right" };
    if (edit.kind === "append") {
      // After the last byte as it is on disk, whatever text it holds.
      writeAll(fd, edit.text, bytes.length);
    } else {
      if (!isUtf8(bytes)) return { ok: false, reason: "it is no longer UTF-8 text, so it is not rewritten" };
      writeAll(fd, edit.text, 0);
      ftruncateSync(fd, Buffer.byteLength(edit.text, "utf8"));
    }
    return { ok: true, created: false };
  } catch (error) {
    return { ok: false, reason: errorCode(error, "the file could not be written") };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function writeAll(fd: number, text: string, position?: number): void {
  const bytes = Buffer.from(text, "utf8");
  let done = 0;
  while (done < bytes.length) {
    done += writeSync(fd, bytes, done, bytes.length - done, position === undefined ? null : position + done);
  }
}

/** A system error's code (EACCES, ENOSPC), never its message, which can repeat a path or more. */
function errorCode(error: unknown, otherwise: string): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" && /^E[A-Z]{2,20}$/.test(code) ? `${otherwise} (${code})` : otherwise;
}
