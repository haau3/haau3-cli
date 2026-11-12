// Reading a small text file the project holds, which may be anything: a link to a FIFO or a device, a
// huge file, a file that changes while it is read, or one in another encoding. One open that cannot
// block, a check of what was opened, and a read that stops past the limit, so no file can hang the
// command or fill its memory.
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";

export type FileRead =
  | { state: "read"; text: string }
  | { state: "missing" }
  /** Not a regular file, over the limit, not readable, or not UTF-8 text. */
  | { state: "unreadable"; why: "not-a-file" | "too-large" | "denied" | "not-text" };

/** O_NONBLOCK is POSIX: on Windows, where opening a pipe this way is not a thing, it is left out. */
const NONBLOCK = process.platform === "win32" ? 0 : constants.O_NONBLOCK;

export function readSmallText(path: string, maxBytes: number): FileRead {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | NONBLOCK);
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return code === "ENOENT" || code === "ENOTDIR" ? { state: "missing" } : { state: "unreadable", why: code === "EISDIR" ? "not-a-file" : "denied" };
  }
  try {
    // What was opened, not what the path named a moment before: a file swapped for a FIFO is caught.
    const stats = fstatSync(fd);
    if (!stats.isFile()) return { state: "unreadable", why: "not-a-file" };
    if (stats.size > maxBytes) return { state: "unreadable", why: "too-large" };
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    for (;;) {
      const read = readSync(fd, buffer, length, buffer.length - length, null);
      if (read === 0) break;
      length += read;
      if (length > maxBytes) return { state: "unreadable", why: "too-large" };
    }
    const bytes = buffer.subarray(0, length);
    // A NUL byte is UTF-16 or binary, not an env file or a manifest as their tools read them.
    if (bytes.includes(0)) return { state: "unreadable", why: "not-text" };
    return { state: "read", text: bytes.toString("utf8") };
  } catch {
    return { state: "unreadable", why: "denied" };
  } finally {
    closeSync(fd);
  }
}
