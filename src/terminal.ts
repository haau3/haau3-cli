// What the command line does only for a person at a terminal: wait for Enter, and open a page in the
// browser. Neither ever runs with no terminal or when an agent is running the command.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { isSafeAddress } from "./environment.js";

/**
 * The indexes a typed answer picks from `count` numbered choices: one number, or for `multiple` any
 * numbers split by commas or spaces. Null when the answer is not that, so the question is asked again.
 */
export function parseChoice(answer: string, count: number, multiple: boolean): number[] | null {
  const words = answer.split(/[\s,]+/).filter(Boolean);
  if (words.length === 0 || (!multiple && words.length > 1)) return null;
  const picked: number[] = [];
  for (const word of words) {
    if (!/^\d{1,3}$/.test(word)) return null;
    const n = Number(word);
    if (n < 1 || n > count) return null;
    if (!picked.includes(n - 1)) picked.push(n - 1);
  }
  return picked;
}

/** Asks on the terminal, at most three times, and reads one line each time. */
export function askOnTerminal(stdin: NodeJS.ReadStream, stdout: NodeJS.WriteStream) {
  return async (question: string, choices: string[], multiple: boolean): Promise<number[] | null> => {
    const rl = createInterface({ input: stdin, output: stdout, terminal: false });
    // Ctrl-D, or the input ending, closes the interface: no answer, so no choice.
    const closed = new Promise<null>((resolve) => rl.once("close", () => resolve(null)));
    try {
      stdout.write(`${question}\n${choices.map((choice, i) => `  ${i + 1}. ${choice}`).join("\n")}\n`);
      for (let tries = 0; tries < 3; tries++) {
        const answer = await Promise.race([rl.question(multiple ? "Numbers, separated by commas: " : "Number: ").catch(() => null), closed]);
        if (answer === null) return null;
        const picked = parseChoice(answer, choices.length, multiple);
        if (picked) return picked;
      }
      return null;
    } finally {
      rl.close();
      stdin.pause();
    }
  };
}

/**
 * Whether a typed answer is the expected text, as GitHub's CLI compares a typed name: spaces around it
 * ignored, and case too, after both are put in one Unicode form.
 */
export function sameText(answer: string, expected: string): boolean {
  const fold = (s: string) => s.normalize("NFC").trim().toLowerCase();
  return fold(answer) === fold(expected) && fold(expected) !== "";
}

/**
 * Asks a person at a terminal to type `expected` to confirm, at most three times: true when they do.
 * Ctrl-D, or the input ending, is no answer, and so is three answers that are not it.
 */
export function confirmOnTerminal(stdin: NodeJS.ReadStream, stdout: NodeJS.WriteStream) {
  return async (question: string, prompt: string, expected: string): Promise<boolean> => {
    const rl = createInterface({ input: stdin, output: stdout, terminal: false });
    const closed = new Promise<null>((resolve) => rl.once("close", () => resolve(null)));
    try {
      stdout.write(`${question}\n`);
      for (let tries = 0; tries < 3; tries++) {
        const answer = await Promise.race([rl.question(prompt).catch(() => null), closed]);
        if (answer === null) return false;
        if (sameText(answer, expected)) return true;
        if (tries < 2) stdout.write("That does not match.\n");
      }
      return false;
    } finally {
      rl.close();
      stdin.pause();
    }
  };
}

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
