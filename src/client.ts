// The SDK's client, made from the settings where the application finds them (src/settings.ts), as
// doctor and test both make it. The command line's own rule for an address it is given comes first:
// https, or http on this computer, with nothing in it that could be a credential. Then the SDK
// decides where calls go, and each refusal it raises is named by its code, with the variable and file.
import { Haau3, Haau3Error } from "@haau3/sdk";
import { clientOptions, sandboxNamed } from "./calls.js";
import { keysCreateStep, type Context } from "./commands/context.js";
import { checkAddress, type Environment } from "./environment.js";
import type { NextStep } from "./output.js";
import { BASE_URL_VARIABLE, ENVIRONMENT_VARIABLE, KEY_VARIABLE, where, type Settings } from "./settings.js";
import { holdsKey } from "./signin/keys.js";

const KEY_MARKER = /haau3_sk_/i;

export type ClientMade =
  /** The project's client, and HAAU3_BASE_URL as checked, when one is set. */
  | { ok: true; client: Haau3; baseURL: string | undefined }
  /** The command line's own rule refused HAAU3_BASE_URL: nothing is sent. */
  | { ok: false; why: "address"; message: string }
  /** The SDK refused only because there is no key and the Sandbox is not named. */
  | { ok: false; why: "no-key"; baseURL: string | undefined }
  /** The SDK refused these settings, by its code. */
  | { ok: false; why: "refused"; code: string | null; message: string; next: NextStep[] };

/** HAAU3_ENVIRONMENT as the SDK will read it: production, sandbox, or something else it refuses. */
export function namedEnvironment(settings: Settings): string | undefined {
  return settings.environment?.value.trim().toLowerCase();
}

/** The SDK's client for these settings, or why there is none. The key is passed even when empty, so the SDK reads none of its own. */
export function makeClient(ctx: Pick<Context, "fetch">, settings: Settings): ClientMade {
  let baseURL: string | undefined;
  if (settings.baseURL) {
    const named = `${BASE_URL_VARIABLE} ${where(settings.baseURL)}`;
    const keyIn = (text: string) => KEY_MARKER.test(text) || (settings.key !== null && holdsKey(text, settings.key.value.trim()));
    const holdsAKey = { ok: false as const, why: "address" as const, message: `${named} holds what looks like an API key, so haau3 will not use it. Remove it, and put the key in ${KEY_VARIABLE}.` };
    if (keyIn(settings.baseURL.value)) return holdsAKey;
    const checked = checkAddress(settings.baseURL.value);
    if (!checked.ok) return { ok: false, why: "address", message: `${named} ${checked.why}, so haau3 will not send a request there. Remove it to call the API at its own address.` };
    // Checked again as parsed: a URL's parser drops line breaks and tabs, which can split a key's marker.
    if (keyIn(checked.address)) return holdsAKey;
    baseURL = checked.address;
  }
  try {
    const client = new Haau3({
      // An empty key, never undefined, so the SDK reads no key of its own from the environment.
      apiKey: settings.key?.value ?? "",
      environment: namedEnvironment(settings) as Environment | undefined,
      baseURL,
      ...clientOptions(ctx.fetch),
    });
    return { ok: true, client, baseURL };
  } catch (error) {
    const code = error instanceof Haau3Error ? error.code : undefined;
    if (code === "no-api-key") return { ok: false, why: "no-key", baseURL };
    const { message, next } = refusalMessage(code, settings);
    return { ok: false, why: "refused", code: code ?? null, message, next };
  }
}

/** A client that sends no key, to the address given or the Sandbox's: the one call a command makes where a key may not go. */
export function keylessClient(ctx: Pick<Context, "fetch">, baseURL: string | undefined): Haau3 | null {
  try {
    // To HAAU3_BASE_URL as checked, never the SDK's own read of the environment.
    return new Haau3({ apiKey: "", environment: "sandbox", baseURL, ...clientOptions(ctx.fetch) });
  } catch {
    return null;
  }
}

/** The SDK's refusal of these settings, in the command line's words, naming each variable and where it is. */
export function refusalMessage(code: string | undefined, settings: Settings): { message: string; next: NextStep[] } {
  const key = settings.key ? `${KEY_VARIABLE} ${where(settings.key)}` : KEY_VARIABLE;
  const environment = settings.environment ? `${ENVIRONMENT_VARIABLE} ${where(settings.environment)}` : ENVIRONMENT_VARIABLE;
  const base = settings.baseURL ? `${BASE_URL_VARIABLE} ${where(settings.baseURL)}` : BASE_URL_VARIABLE;
  const file = settings.key?.path ? settings.key.source : undefined;
  const sandboxCause = sandboxNamed(settings) ? `${environment} names the Sandbox` : `${base} is the Sandbox's address`;
  switch (code) {
    case "api-key-not-alone":
      return { message: `${key} has something before its haau3_sk_ prefix, such as quotes or "Bearer ". Set the key alone.`, next: [] };
    case "test-key-outside-sandbox":
      return {
        message: `${key} is a test key, which works only in the Sandbox, and ${environment} names production. Remove ${ENVIRONMENT_VARIABLE} to call the Sandbox with it, or use a live key.`,
        next: [keysCreateStep({ replace: true, file }, "Make a live key in place of the test key.")],
      };
    case "live-key-in-sandbox":
      return {
        message: `${key} is a live key, which does not work in the Sandbox, and ${sandboxCause}. Use a test key there.`,
        next: [keysCreateStep({ test: true, replace: true, file }, "Make a test key in place of the live key.")],
      };
    case "older-key-in-sandbox":
      return {
        message: `${key} was made before live and test keys, so it does not work in the Sandbox, and ${sandboxCause}. Use a test key there.`,
        next: [keysCreateStep({ test: true, replace: true, file }, "Make a test key in place of the older key.")],
      };
    case "invalid-environment":
      return { message: `${environment} is neither production nor sandbox.`, next: [] };
    case "invalid-base-url":
      return { message: `${base} is not an http or https address with a host.`, next: [] };
    case "environment-conflicts-with-base-url":
      return { message: `${environment} names one environment, and ${base} is the other's own address. Name one environment, or remove one of them.`, next: [] };
    default:
      return {
        message: `haau3 could not make the SDK's client${code ? ` (${code})` : ""}.`,
        next: [{ command: "npx haau3@latest --version", description: "Check for a newer version, then report it at https://github.com/haau3/haau3-cli/issues." }],
      };
  }
}
