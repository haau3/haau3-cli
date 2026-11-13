#!/usr/bin/env node
import { main } from "./main.js";
import { askOnTerminal, confirmOnTerminal, listenForEnter, openBrowser } from "./terminal.js";

process.exitCode = await main(process.argv.slice(2), {
  stdout: process.stdout,
  stderr: process.stderr,
  stdin: process.stdin,
  env: process.env,
  cwd: process.cwd(),
  enter: () => listenForEnter(process.stdin),
  openBrowser: (url) => openBrowser(url),
  ask: askOnTerminal(process.stdin, process.stdout),
  confirm: confirmOnTerminal(process.stdin, process.stdout),
});
