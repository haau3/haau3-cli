// Where a call goes. The one place the command line decides it, so that giving the Sandbox a host of
// its own one day changes this file and nothing else.
import type { CliError } from "./output.js";

/** The API's two environments: production, and the Sandbox, its twin that answers with test data. */
export type Environment = "production" | "sandbox";

export const DEFAULT_BASE_URL = "https://api.haau3.com";

/** The variable the SDKs read too, so a project points both at the same place. */
export const BASE_URL_VARIABLE = "HAAU3_BASE_URL";

export interface Target {
  environment: Environment;
  /** The address calls to this environment go to, with no trailing slash. */
  baseURL: string;
}

export type TargetResult = { ok: true; target: Target } | { ok: false; error: CliError };

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Today both environments are the API's host: the Sandbox is a path on it, which the SDK's Sandbox
 * methods name. HAAU3_BASE_URL points both elsewhere, for development: an https address, or http on
 * this computer. The value itself is never repeated back.
 */
export function resolveTarget(environment: Environment, env: NodeJS.ProcessEnv): TargetResult {
  const configured = env[BASE_URL_VARIABLE]?.trim();
  if (!configured) return { ok: true, target: { environment, baseURL: DEFAULT_BASE_URL } };

  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    return { ok: false, error: invalidBaseURL("is not an address") };
  }
  if (url.username || url.password) return { ok: false, error: invalidBaseURL("carries a user name or password") };
  if (url.search || url.hash) return { ok: false, error: invalidBaseURL("carries a query or a fragment") };
  const secure = url.protocol === "https:" || (url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname));
  if (!secure) return { ok: false, error: invalidBaseURL("is neither https nor http on this computer") };

  const baseURL = `${url.origin}${url.pathname}`.replace(/\/+$/, "");
  return { ok: true, target: { environment, baseURL } };
}

function invalidBaseURL(why: string): CliError {
  return {
    code: "invalid-base-url",
    message: `${BASE_URL_VARIABLE} ${why}.`,
    next: [
      {
        command: `unset ${BASE_URL_VARIABLE}`,
        description: `Call the API at ${DEFAULT_BASE_URL}, the address it has unless you are developing against another.`,
      },
    ],
  };
}
