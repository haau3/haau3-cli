import { PLATFORM_URL_VARIABLE } from "./environment.js";
import { OUTPUT_VARIABLE } from "./output.js";
import { CONFIG_DIR_VARIABLE } from "./session/file.js";
import { STORE_VARIABLE } from "./session/store.js";
import { VERSION } from "./version.js";

export interface HelpEntry {
  name: string;
  description: string;
}

export interface Help {
  usage: string;
  commands: HelpEntry[];
  options: HelpEntry[];
  environment: HelpEntry[];
  docs: string;
}

export const HELP: Help = {
  usage: "haau3 [command] [options]",
  commands: [
    { name: "login", description: "Sign in: a person approves this computer in the browser. With no terminal, it prints the page and the code, then exits." },
    { name: "login --complete", description: "Wait for that approval, then finish signing in." },
    { name: "whoami", description: "Who is signed in, the organization, its plan and this month's use." },
    { name: "logout", description: "Sign out, and end the approval." },
  ],
  options: [
    { name: "--json", description: "Print one JSON document. Automatic when output is not a terminal." },
    { name: "-h, --help", description: "Show this help." },
    { name: "--version", description: "Show the version." },
  ],
  environment: [
    { name: OUTPUT_VARIABLE, description: "json or text: the output to print, whatever the terminal." },
    { name: PLATFORM_URL_VARIABLE, description: "Sign in at another address than https://platform.haau3.com, for development." },
    { name: STORE_VARIABLE, description: "file: keep the session in a file only you can read, not the system's credential store." },
    { name: CONFIG_DIR_VARIABLE, description: "The folder for that file. By default ~/.config/haau3, or %APPDATA%\\haau3 on Windows." },
  ],
  docs: "https://docs.haau3.com",
};

export function helpText(): string {
  const all = [...HELP.commands, ...HELP.options, ...HELP.environment];
  const width = Math.max(...all.map((e) => e.name.length)) + 2;
  const rows = (entries: HelpEntry[]) => entries.map((e) => `  ${e.name.padEnd(width)}${e.description}`).join("\n");
  return [
    `haau3 ${VERSION}: the command line for the haau3 platform API.`,
    "",
    `Usage: ${HELP.usage}`,
    "",
    "Commands:",
    rows(HELP.commands),
    "",
    "Options:",
    rows(HELP.options),
    "",
    "Environment:",
    rows(HELP.environment),
    "",
    `Docs: ${HELP.docs}`,
    "",
  ].join("\n");
}
