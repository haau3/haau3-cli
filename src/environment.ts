// Where a call goes. The one place the command line decides it, so that giving the Sandbox a host of
// its own one day changes this file and nothing else. The platform's address, where signing in
// starts, is decided here too, by the same rules.
import type { CliError } from "./output.js";

/** The API's two environments: production, and the Sandbox, its twin that answers with test data. */
export type Environment = "production" | "sandbox";

export const DEFAULT_BASE_URL = "https://api.haau3.com";

/** The variable the SDKs read too, so a project points both at the same place. */
export const BASE_URL_VARIABLE = "HAAU3_BASE_URL";

/** Where signing in starts: the dashboard's address, which says how to sign in (RFC 9728). */
export const DEFAULT_PLATFORM_URL = "https://platform.haau3.com";

/** Points signing in at another copy of the platform, for development. */
export const PLATFORM_URL_VARIABLE = "HAAU3_PLATFORM_URL";

export interface Target {
  environment: Environment;
  /** The address calls to this environment go to, with no trailing slash. */
  baseURL: string;
}

export type TargetResult = { ok: true; target: Target } | { ok: false; error: CliError };

export type PlatformResult = { ok: true; platformURL: string } | { ok: false; error: CliError };

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Whether an address is https, or http on this computer: the only addresses the command line calls. */
export function isSafeAddress(url: URL): boolean {
  return url.protocol === "https:" || (url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname));
}

type AddressCheck = { ok: true; address: string } | { ok: false; why: string };

/** The address with no trailing slash, or why it cannot be used. The value itself is never repeated. */
function checkAddress(configured: string): AddressCheck {
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    return { ok: false, why: "is not an address" };
  }
  if (url.username || url.password) return { ok: false, why: "carries a user name or password" };
  if (url.search || url.hash) return { ok: false, why: "carries a query or a fragment" };
  if (!isSafeAddress(url)) return { ok: false, why: "is neither https nor http on this computer" };
  return { ok: true, address: `${url.origin}${url.pathname}`.replace(/\/+$/, "") };
}

/**
 * Today both environments are the API's host: the Sandbox is a path on it, which the SDK's Sandbox
 * methods name. HAAU3_BASE_URL points both elsewhere, for development: an https address, or http on
 * this computer.
 */
export function resolveTarget(environment: Environment, env: NodeJS.ProcessEnv): TargetResult {
  const configured = env[BASE_URL_VARIABLE]?.trim();
  if (!configured) return { ok: true, target: { environment, baseURL: DEFAULT_BASE_URL } };
  const checked = checkAddress(configured);
  if (!checked.ok) return { ok: false, error: invalidAddress(BASE_URL_VARIABLE, checked.why, "invalid-base-url", `Call the API at ${DEFAULT_BASE_URL}, the address it has unless you are developing against another.`) };
  return { ok: true, target: { environment, baseURL: checked.address } };
}

/** The platform's address: platform.haau3.com, or HAAU3_PLATFORM_URL by the same rules as the API's. */
export function resolvePlatform(env: NodeJS.ProcessEnv): PlatformResult {
  const configured = env[PLATFORM_URL_VARIABLE]?.trim();
  if (!configured) return { ok: true, platformURL: DEFAULT_PLATFORM_URL };
  const checked = checkAddress(configured);
  if (!checked.ok) return { ok: false, error: invalidAddress(PLATFORM_URL_VARIABLE, checked.why, "invalid-platform-url", `Sign in at ${DEFAULT_PLATFORM_URL}, the address it has unless you are developing against another.`) };
  return { ok: true, platformURL: checked.address };
}

function invalidAddress(variable: string, why: string, code: string, description: string): CliError {
  return { code, message: `${variable} ${why}.`, next: [{ command: `unset ${variable}`, description }] };
}
