// Writing a file in the project for a coding agent: only under the project's folder, never through a
// link (a linked folder could carry the write anywhere), never over anything but a regular file, and
// only when the content differs, so a second run writes nothing.
import { closeSync, constants, lstatSync, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { readSmallText } from "../files.js";

export type Inspected =
  /** text is null when the file is not there yet. */
  | { ok: true; path: string; text: string | null }
  | { ok: false; why: string };

/** O_NOFOLLOW is POSIX: on Windows, where it is not defined, the check before the open stands alone. */
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

/**
 * A file the project holds at `relative` (parts split by /), checked part by part: each folder on the
 * way must be a real folder or missing, and the file a regular file or missing. Its text when it is
 * there and can be read as text of at most `maxBytes`.
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
      if (code === "ENOENT") return { ok: true, path, text: null };
      return { ok: false, why: `${named} could not be read` };
    }
    if (stats.isSymbolicLink()) return { ok: false, why: `${named} is a link, which haau3 does not write through` };
    const last = i === parts.length - 1;
    if (!last && !stats.isDirectory()) return { ok: false, why: `${named} is not a folder` };
    if (last && !stats.isFile()) return { ok: false, why: `${named} is not a regular file` };
  }
  const read = readSmallText(path, maxBytes);
  if (read.state === "read") return { ok: true, path, text: read.text };
  if (read.state === "missing") return { ok: true, path, text: null };
  const why = read.why === "too-large" ? "is too large to be one haau3 writes" : read.why === "not-text" ? "is not text" : "could not be read";
  return { ok: false, why: `${relative} ${why}` };
}

/** Writes a file inspectProjectFile passed, making its folders, and never following a link at the file. */
export function writeProjectFile(path: string, content: string | Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | NOFOLLOW, 0o644);
  try {
    const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : content;
    let written = 0;
    while (written < bytes.length) written += writeSync(fd, bytes, written, bytes.length - written);
  } finally {
    closeSync(fd);
  }
}

/** What happened to one file. */
export type FileOutcome =
  | { file: string; result: "created" | "updated" | "unchanged" }
  /** Left as it was, and why: init never changes a file it cannot read or one that is the person's. */
  | { file: string; result: "left"; why: string };
