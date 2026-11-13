// Writing a file in the project for a coding agent: only under the project's folder, never through a
// link (a linked folder, or a hard link to a file elsewhere, could carry the write anywhere), never
// over anything but a regular file, and only when the content differs, so a second run writes
// nothing. A write goes to a new file beside the target, then is renamed over it, so the target is
// replaced whole or not at all, and a name swapped for a link after the check is replaced, not followed.
import { randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { within } from "../run.js";

/** O_NOFOLLOW and O_NONBLOCK are POSIX: on Windows, where they are not defined, the checks around the open stand alone. */
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const NONBLOCK = process.platform === "win32" ? 0 : constants.O_NONBLOCK;

export type Inspected =
  | {
      ok: true;
      path: string;
      exists: boolean;
      /** The file's bytes; null when it is not there, or larger than the limit given. */
      bytes: Buffer | null;
      /** Its permission bits, kept when it is replaced. */
      mode: number | null;
    }
  /** link: a link or a hard link is in the way, which no write may go through. */
  | { ok: false; why: string; link: boolean };

function readBytes(path: string, maxBytes: number): { bytes: Buffer | null; mode: number; nlink: number } | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | NONBLOCK | NOFOLLOW);
  } catch {
    return null;
  }
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile()) return null;
    if (stats.size > maxBytes) return { bytes: null, mode: stats.mode & 0o777, nlink: stats.nlink };
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    for (;;) {
      const read = readSync(fd, buffer, length, buffer.length - length, null);
      if (read === 0) break;
      length += read;
      if (length > maxBytes) return { bytes: null, mode: stats.mode & 0o777, nlink: stats.nlink };
    }
    return { bytes: buffer.subarray(0, length), mode: stats.mode & 0o777, nlink: stats.nlink };
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/**
 * A file the project holds at `relative` (parts split by /), checked part by part: each folder on the
 * way must be a real folder or missing, and the file a regular file with no other name, or missing.
 * Its bytes when it is at most `maxBytes`.
 */
export function inspectProjectFile(cwd: string, relative: string, maxBytes: number): Inspected {
  const parts = relative.split("/");
  const path = join(resolve(cwd), ...parts);
  let at = resolve(cwd);
  for (let i = 0; i < parts.length; i++) {
    at = join(at, parts[i]!);
    const named = parts.slice(0, i + 1).join("/");
    let stats;
    try {
      stats = lstatSync(at);
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code === "ENOENT") return { ok: true, path, exists: false, bytes: null, mode: null };
      return { ok: false, why: `${named} could not be read`, link: false };
    }
    if (stats.isSymbolicLink()) return { ok: false, why: `${named} is a link, which haau3 does not write through`, link: true };
    const last = i === parts.length - 1;
    if (!last && !stats.isDirectory()) return { ok: false, why: `${named} is not a folder`, link: false };
    if (last && !stats.isFile()) return { ok: false, why: `${named} is not a regular file`, link: false };
  }
  const read = readBytes(path, maxBytes);
  if (read === null) return { ok: false, why: `${relative} could not be read`, link: false };
  if (read.nlink > 1) return { ok: false, why: `${relative} has another name on disk (a hard link), which haau3 does not write through`, link: true };
  return { ok: true, path, exists: true, bytes: read.bytes, mode: read.mode };
}

/** The bytes as text, or null when they are not UTF-8 text a tool would write. */
export function textOf(bytes: Buffer): string | null {
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Writes a file inspectProjectFile passed: its folders made, checked still inside the project by
 * their real path, then a new file beside it renamed over it. Throws when it cannot.
 */
export function writeProjectFile(cwd: string, path: string, content: string | Uint8Array, mode: number | null = null): void {
  const folder = dirname(path);
  mkdirSync(folder, { recursive: true });
  if (!within(realpathSync.native(folder), realpathSync.native(cwd), process.platform)) throw new Error("The folder is not inside the project.");
  const temporary = join(folder, `.haau3-${randomBytes(6).toString("hex")}.tmp`);
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, mode ?? 0o644);
  try {
    const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : content;
    let written = 0;
    while (written < bytes.length) written += writeSync(fd, bytes, written, bytes.length - written);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

/** What happened to one file. */
export type FileOutcome =
  | { file: string; result: "created" | "updated" | "unchanged" }
  /** Left as it was, and why: init never changes a file it cannot read or one that is the person's. link: a link was in the way. */
  | { file: string; result: "left"; why: string; link?: boolean };
