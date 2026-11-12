// How the command line learns where to sign in, from the platform's address alone. The platform
// publishes its protected-resource metadata (RFC 9728), which names the authorization server and the
// command line's public client id; the authorization server publishes its own (RFC 8414), which
// names the device, token and revocation endpoints. Nothing about the sign-in service is built in.
import { DEFAULT_PLATFORM_URL, isSafeAddress } from "../environment.js";
import type { CliError } from "../output.js";
import { call, isRecord, problemOf, retryAfterSeconds, text, type HttpResult } from "./http.js";

/** The command line's endpoints on the platform. */
export const CLI_API_PATH = "/api/cli/v1";

const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

/** Everything signing in needs, as the platform and the sign-in service published it. */
export interface SignInService {
  /** The platform's address, which keys the session in the store. */
  platformURL: string;
  issuer: string;
  clientId: string;
  /** The scopes to ask for, space-separated; empty when the platform names none. */
  scope: string;
  deviceEndpoint: string;
  tokenEndpoint: string;
  revocationEndpoint: string;
}

export type DiscoveryResult = { ok: true; service: SignInService } | { ok: false; error: CliError };

/** The resource the session is for: the platform's command-line endpoints. */
export function resourceOf(platformURL: string): string {
  return `${platformURL}${CLI_API_PATH}`;
}

/** RFC 9728, section 3.1: the well-known segment goes between the host and the resource's path. */
export function resourceMetadataURL(resource: string): string {
  const url = new URL(resource);
  return `${url.origin}/.well-known/oauth-protected-resource${url.pathname.replace(/\/+$/, "")}`;
}

/** RFC 8414, section 3.1: the same insertion for the authorization server's issuer. */
export function authorizationServerMetadataURL(issuer: string): string {
  const url = new URL(issuer);
  const path = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "");
  return `${url.origin}/.well-known/oauth-authorization-server${path}`;
}

/** A scope token (RFC 6749, section 3.3). */
const SCOPE_TOKEN = /^[\x21\x23-\x5b\x5d-\x7e]{1,100}$/;

export async function discover(platformURL: string): Promise<DiscoveryResult> {
  const host = new URL(platformURL).host;
  const resource = resourceOf(platformURL);
  const platformAnswer = await call(resourceMetadataURL(resource));
  if (!platformAnswer.answered) return fail(platformUnreachable(host));
  if (platformAnswer.status === 404) return fail(signInUnavailable(platformURL, platformAnswer));
  if (platformAnswer.status >= 500) return fail(platformUnavailable(host, platformAnswer));
  if (platformAnswer.status !== 200) return fail(unexpected(`${host} answered the request for its sign-in details with HTTP ${platformAnswer.status}.`, platformAnswer));

  const metadata = platformAnswer.body;
  if (!isRecord(metadata) || metadata.resource !== resource) {
    // RFC 9728, section 3.3: metadata for another resource is not this one's.
    return fail(unexpected(`${host}'s sign-in details are not for its command-line endpoints.`, platformAnswer));
  }
  const servers = metadata.authorization_servers;
  const issuer = Array.isArray(servers) && servers.length >= 1 ? checkIssuer(servers[0]) : undefined;
  const clientId = text(metadata.haau3_client_id, 200);
  if (!issuer || !clientId) return fail(unexpected(`${host}'s sign-in details name no usable sign-in service.`, platformAnswer));
  if (!issuerAllowed(platformURL, issuer)) return fail(unexpected(`${host} named a sign-in service outside haau3.com.`, platformAnswer));
  const listed = Array.isArray(metadata.scopes_supported) ? metadata.scopes_supported : [];
  if (!listed.every((s) => typeof s === "string" && SCOPE_TOKEN.test(s))) return fail(unexpected(`${host}'s sign-in details name a scope haau3 cannot ask for.`, platformAnswer));
  // Never offline_access: the command line asks for no refresh token, and keeps none it is given.
  const scopes = (listed as string[]).filter((s) => s !== "offline_access");

  // From here the answers are the sign-in service's, whose request id would not be the platform's,
  // so the errors built from them carry no problem.
  const issuerHost = new URL(issuer).host;
  const serverAnswer = await call(authorizationServerMetadataURL(issuer));
  if (!serverAnswer.answered || serverAnswer.status >= 500) return fail(signInUnreachable(issuerHost));
  if (serverAnswer.status !== 200 || !isRecord(serverAnswer.body)) return fail(unexpected(`The sign-in service at ${issuerHost} did not describe itself.`));
  const server = serverAnswer.body;
  // RFC 8414, section 3.3: the issuer it names must be the one the platform named.
  if (server.issuer !== issuer) return fail(unexpected(`The sign-in service at ${issuerHost} names another issuer.`));
  const grants = server.grant_types_supported;
  if (Array.isArray(grants) && !grants.includes(DEVICE_GRANT)) return fail(unexpected(`The sign-in service at ${issuerHost} does not offer sign-in by code.`));
  const deviceEndpoint = checkEndpoint(server.device_authorization_endpoint, issuer);
  const tokenEndpoint = checkEndpoint(server.token_endpoint, issuer);
  const revocationEndpoint = checkEndpoint(server.revocation_endpoint, issuer);
  if (!deviceEndpoint || !tokenEndpoint || !revocationEndpoint) return fail(unexpected(`The sign-in service at ${issuerHost} does not name the endpoints haau3 needs on its own address.`));

  return {
    ok: true,
    service: { platformURL, issuer, clientId, scope: scopes.join(" "), deviceEndpoint, tokenEndpoint, revocationEndpoint },
  };
}

/** An issuer: https, or http on this computer, with no user, query or fragment. */
export function checkIssuer(value: unknown): string | undefined {
  const raw = text(value, 500);
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (!isSafeAddress(url) || url.username || url.password || url.search || url.hash) return undefined;
    return raw;
  } catch {
    return undefined;
  }
}

/**
 * An endpoint on the issuer's own origin, so a token is never sent anywhere the issuer is not. RFC 8414
 * allows an endpoint elsewhere; this command line does not.
 */
export function checkEndpoint(value: unknown, issuer: string): string | undefined {
  const raw = text(value, 500);
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (url.origin !== new URL(issuer).origin || url.username || url.password || url.hash) return undefined;
    return raw;
  } catch {
    return undefined;
  }
}

/**
 * haau3's own platform signs in only on a haau3.com host, so an answer from it that names any other is
 * refused. Another platform address, for development, names whatever it serves.
 */
export function issuerAllowed(platformURL: string, issuer: string): boolean {
  if (platformURL !== DEFAULT_PLATFORM_URL) return true;
  const url = new URL(issuer);
  return url.protocol === "https:" && (url.hostname === "haau3.com" || url.hostname.endsWith(".haau3.com"));
}

/** Whether a stored service is the one discovery finds now: the same issuer, client and endpoints. */
export function sameService(a: SignInService, b: SignInService): boolean {
  return (
    a.issuer === b.issuer &&
    a.clientId === b.clientId &&
    a.deviceEndpoint === b.deviceEndpoint &&
    a.tokenEndpoint === b.tokenEndpoint &&
    a.revocationEndpoint === b.revocationEndpoint
  );
}

function fail(error: CliError): DiscoveryResult {
  return { ok: false, error };
}

const AGAIN = { command: "npx haau3 login", description: "Try signing in again." };

export function platformUnreachable(host: string): CliError {
  return { code: "platform-unreachable", message: `${host} did not answer. Check the connection and try again.`, next: [AGAIN] };
}

export function signInUnreachable(host: string): CliError {
  return { code: "sign-in-unreachable", message: `The sign-in service at ${host} did not answer. Check the connection and try again.`, next: [AGAIN] };
}

export function platformUnavailable(host: string, answer: HttpResult & { answered: true }): CliError {
  const wait = retryAfterSeconds(answer.headers);
  const when = wait === undefined ? "Try again in a minute." : `Try again in ${wait} seconds.`;
  return { code: "platform-unavailable", message: `${host} could not answer just now. ${when}`, next: [], problem: problemOf(answer) };
}

/** The platform's 404 for its command-line endpoints: carries that answer's problem when given it. */
export function signInUnavailable(platformURL: string, answer?: HttpResult & { answered: true }): CliError {
  const host = new URL(platformURL).host;
  const error: CliError = {
    code: "sign-in-unavailable",
    message: `Signing in from the command line is not open on ${host} yet. Make an API key on the dashboard at ${platformURL}/dashboard/keys instead.`,
    next: [],
  };
  if (answer) error.problem = problemOf(answer);
  return error;
}

function unexpected(message: string, answer?: HttpResult & { answered: true }): CliError {
  const error: CliError = { code: "unexpected-answer", message, next: [{ command: "npx haau3@latest --version", description: "Check for a newer haau3, then report it at https://github.com/haau3/haau3-cli/issues." }] };
  if (answer) error.problem = problemOf(answer);
  return error;
}
