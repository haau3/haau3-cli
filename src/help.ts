import { DOCS_URL_VARIABLE, PLATFORM_URL_VARIABLE } from "./environment.js";
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
      name: "init",
      description:
        "Set this project up for haau3: its SDK through the project's package manager, the haau3 skill and the docs' MCP server for its coding agents, and git ignoring its env file. Writes no application code.",
    },
    { name: "init --agent <agent>", description: "Set up this coding agent: claude-code, cursor, codex, vscode or gemini-cli. Give it once for each agent." },
    { name: "init --no-agent", description: "Set up no coding agent: only the SDK and the env file." },
    { name: "init --language <language>", description: "node, python or go: the project to set up, when the folder holds more than one." },
    { name: "init --package-manager <name>", description: "The package manager to install with, when the project's files name more than one." },
    { name: "init --file <file>", description: "Check this env file in place of .env.local and .env." },
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
    { name: "keys list", description: "The signed-in organization's active keys: name, prefix, mode, when made and last used, and id. Marks the key this project uses. Never a key." },
    { name: "keys list --all", description: "Revoked keys too." },
    {
      name: "keys revoke <id>",
      description: "Revoke a key, for a person at a terminal, who types its name to confirm. Refused with no terminal or when a coding agent runs it. Revoking ends the sign-in.",
    },
  ],
  options: [
    { name: "--json", description: "Print one JSON document. Automatic when output is not a terminal." },
    { name: "-h, --help", description: "Show this help." },
    { name: "--version", description: "Show the version." },
  ],
  environment: [
    { name: KEY_VARIABLE, description: "The API key: here, else in the project's env files as its loader reads them (.env.local, then .env for Next.js; .env otherwise)." },
    { name: ENVIRONMENT_VARIABLE, description: "production or sandbox: the environment to call. With sandbox, no key is needed." },
    { name: BASE_URL_VARIABLE, description: "Call the API at another address, such as a stand-in, for development." },
    { name: OUTPUT_VARIABLE, description: "json or text: the output to print, whatever the terminal." },
    { name: PLATFORM_URL_VARIABLE, description: "Sign in at another address than https://platform.haau3.com, for development." },
    { name: DOCS_URL_VARIABLE, description: "Read the haau3 skill and name the docs' MCP server at another address than https://docs.haau3.com, for development." },
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
