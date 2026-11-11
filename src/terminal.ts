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
 * The system's own opener, by its full path where it has a fixed one. Windows looks in the current
 * folder before PATH, so a bare name could run a program a project ships under that name.
 */
export function opener(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): [string, string[]] {
  if (platform === "darwin") return ["/usr/bin/open", []];
  if (platform === "win32") return [`${env.SystemRoot ?? "C:\\Windows"}\\System32\\rundll32.exe`, ["url.dll,FileProtocolHandler"]];
  return ["xdg-open", []];
}

/**
 * Opens an https page (or http on this computer) in the default browser, with the system's opener and
 * no shell, so nothing in the address is read as a command. False when the opener did not start.
 */
export function openBrowser(address: string, platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return Promise.resolve(false);
  }
  if (!isSafeAddress(url) || url.username || url.password) return Promise.resolve(false);
  const [command, args] = opener(platform, env);
  return new Promise((resolve) => {
    try {
      const child = spawn(command, [...args, url.href], { stdio: "ignore", detached: true, shell: false, windowsHide: true, env });
      child.once("spawn", () => {
        child.unref();
        resolve(true);
      });
      child.once("error", () => resolve(false));
    } catch {
      resolve(false);
    }
  });
}
