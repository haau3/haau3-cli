// The addresses the command line calls. Where an API call goes is the SDK's to decide: the key's mode
// picks the host, and HAAU3_ENVIRONMENT and HAAU3_BASE_URL change it (see src/settings.ts). What stays
// here is the rule every address the command line itself is given must keep, and the platform's
// address, where signing in starts.
import type { CliError } from "./output.js";

/** The API's two environments: production, and the Sandbox, its twin that answers with fixed answers and test data. */
export type Environment = "production" | "sandbox";

/** Each environment's own address, as the SDK has it. */
export const ENVIRONMENT_ADDRESSES: Readonly<Record<Environment, string>> = {
  production: "https://api.haau3.com",
  sandbox: "https://sandbox.haau3.com",
};

/** Where signing in starts: the dashboard's address, which says how to sign in (RFC 9728). */
export const DEFAULT_PLATFORM_URL = "https://platform.haau3.com";

/** Points signing in at another copy of the platform, for development. */
export const PLATFORM_URL_VARIABLE = "HAAU3_PLATFORM_URL";

export type PlatformResult = { ok: true; platformURL: string } | { ok: false; error: CliError };

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Whether an address is https, or http on this computer: the only addresses the command line calls. */
export function isSafeAddress(url: URL): boolean {
  return url.protocol === "https:" || (url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname));
}

export type AddressCheck = { ok: true; address: string } | { ok: false; why: string };

/** The address with no trailing slash, or why it cannot be used. The value itself is never repeated. */
export function checkAddress(configured: string): AddressCheck {
  let url: URL;
  try {
    url = new URL(configured.trim());
  } catch {
    return { ok: false, why: "is not an address" };
  }
  if (url.username || url.password) return { ok: false, why: "carries a user name or password" };
  if (url.search || url.hash) return { ok: false, why: "carries a query or a fragment" };
  // api.haau3.com. is api.haau3.com to DNS but not to a comparison of addresses.
  if (url.hostname.endsWith(".")) return { ok: false, why: "has a host that ends in a dot" };
  if (!isSafeAddress(url)) return { ok: false, why: "is neither https nor http on this computer" };
  return { ok: true, address: `${url.origin}${url.pathname}`.replace(/\/+$/, "") };
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
