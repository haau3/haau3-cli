import { PLATFORM_URL_VARIABLE } from "./environment.js";
import { BASE_URL_VARIABLE, ENVIRONMENT_VARIABLE, KEY_VARIABLE } from "./settings.js";
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
    {
      name: "doctor",
      description: "Check that this project is ready to call the API: Node, the SDK, the key and where it is, git ignoring its file, and a call that proves the key works.",
    },
    { name: "doctor --file <file>", description: "Read this env file in place of .env.local and .env." },
    {
      name: "test [service]",
      description: "One call to each service, or to the one named, built from the API's published spec. Says what kind of answer came back; never prints one.",
    },
    { name: "test <service> --all", description: "Every operation of the service. Each call counts as a request." },
    { name: "test --file <file>", description: "Read this env file in place of .env.local and .env." },
    { name: "login", description: "Sign in: a person approves this computer in the browser. With no terminal, it prints the page and the code, then exits." },
    { name: "login --complete", description: "Wait for that approval, then finish signing in." },
    { name: "whoami", description: "Who is signed in, the organization, its plan and this month's use." },
    { name: "logout", description: "Sign out, and end the approval." },
    {
      name: "keys create",
      description: "Make a live API key for the signed-in organization and write it to the project's env file as HAAU3_API_KEY. The key is never shown. Making a key ends the sign-in.",
    },
    { name: "keys create --test", description: "Make a test key instead, which reaches the Sandbox only." },
    { name: "keys create --name <name>", description: "Name the key. By default the name says haau3 made it, for which folder and on which day." },
    { name: "keys create --file <file>", description: "Write to this env file. By default the one that holds the key, else .env.local, else .env." },
    { name: "keys create --replace", description: "Replace a key the file already holds. The old key is not revoked." },
  ],
  options: [
    { name: "--json", description: "Print one JSON document. Automatic when output is not a terminal." },
    { name: "-h, --help", description: "Show this help." },
    { name: "--version", description: "Show the version." },
  ],
  environment: [
    { name: KEY_VARIABLE, description: "The API key, as the SDKs read it: here, else in .env.local, else in .env." },
    { name: ENVIRONMENT_VARIABLE, description: "production or sandbox: the environment to call. With sandbox, no key is needed." },
    { name: BASE_URL_VARIABLE, description: "Call the API at another address, such as a stand-in, for development." },
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
