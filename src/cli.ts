#!/usr/bin/env node
import { main } from "./main.js";
import { keyringCallStuck } from "./session/keyring.js";
import { listenForEnter, openBrowser } from "./terminal.js";

const code = await main(process.argv.slice(2), {
  stdout: process.stdout,
  stderr: process.stderr,
  stdin: process.stdin,
  env: process.env,
  cwd: process.cwd(),
  enter: () => listenForEnter(process.stdin),
  openBrowser: (url) => openBrowser(url),
});
process.exitCode = code;

// A credential store that never answered can hold the process open. End it once what was printed has
// gone out.
if (keyringCallStuck()) process.stdout.write("", () => process.exit(code));
