import { OUTPUT_VARIABLE } from "./output.js";
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
  usage: "haau3 [options]",
  commands: [],
  options: [
    { name: "--json", description: "Print one JSON document. Automatic when output is not a terminal." },
    { name: "-h, --help", description: "Show this help." },
    { name: "--version", description: "Show the version." },
  ],
  environment: [{ name: OUTPUT_VARIABLE, description: "json or text: the output to print, whatever the terminal." }],
  docs: "https://docs.haau3.com",
};

export function helpText(): string {
  const width = Math.max(...[...HELP.options, ...HELP.environment].map((e) => e.name.length)) + 2;
  const rows = (entries: HelpEntry[]) => entries.map((e) => `  ${e.name.padEnd(width)}${e.description}`).join("\n");
  return [
    `haau3 ${VERSION}: the command line for the haau3 platform API.`,
    "",
    `Usage: ${HELP.usage}`,
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
