// What the command line does only for a person at a terminal: wait for Enter, and open a page in the
// browser. Neither ever runs with no terminal or when an agent is running the command.
import { spawn } from "node:child_process";
import { isSafeAddress } from "./environment.js";

/** Resolves when a line is entered on stdin. stop() stops listening, so the process can end. */
export function listenForEnter(stdin: NodeJS.ReadStream): { pressed: Promise<void>; stop(): void } {
  let stop = () => {};
  const pressed = new Promise<void>((resolve) => {
    const onData = (chunk: Buffer | string) => {
      const line = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      if (line.includes("\n") || line.includes("\r")) {
        stop();
        resolve();
      }
    };
    stop = () => {
      stdin.off("data", onData);
      stdin.pause();
      stdin.unref?.();
    };
    stdin.on("data", onData);
    stdin.resume();
  });
  return { pressed, stop: () => stop() };
}

/**
 * Opens an https page (or http on this computer) in the default browser, with the system's own
 * opener and no shell, so nothing in the address is read as a command. False when it could not start.
 */
export function openBrowser(address: string, platform: NodeJS.Platform = process.platform): boolean {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return false;
  }
  if (!isSafeAddress(url) || url.username || url.password) return false;
  const [command, args] =
    platform === "darwin"
      ? ["open", [url.href]]
      : platform === "win32"
        ? ["rundll32", ["url.dll,FileProtocolHandler", url.href]]
        : ["xdg-open", [url.href]];
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true, shell: false });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}
