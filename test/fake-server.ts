// A stand-in for the platform and its sign-in service on one local port: the platform's
// protected-resource metadata, whoami and keys, and an authorization server under /issuer with its own
// metadata, device authorization, token and revocation endpoints. Each answer is scripted per test,
// and every request is recorded. The tokens and the device code it hands out are planted markers, so
// the secrets test can look for them in everything the command line prints and keeps.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

const CORE = ["PLANTED", "SIGNIN", "5c2e81"].join("");
/** Built from parts, so no file in this repository holds a whole token-shaped string. */
export const ACCESS_TOKEN = ["oat", `${CORE}access`].join("_");
export const REFRESH_TOKEN = ["oat", `${CORE}refresh`].join("_");
export const DEVICE_CODE = `${CORE}devicecode`;
export const USER_CODE = "WDJB-MJHT";
export const SIGN_IN_MARKERS = [ACCESS_TOKEN, REFRESH_TOKEN, DEVICE_CODE, CORE];

/**
 * The new key's secret. Its first six characters after the mode's prefix are plain, as the prefix the
 * keys page shows; the marker comes straight after, so anything printed past the prefix is caught.
 */
// Unlike the other planted secrets' cores, which begin PLANTED: the prefix of a key already in a
// file is printed on purpose, and must not read as a piece of the new one.
export const NEW_KEY_CORE = ["FRESH", "MINT", "9d4b2a"].join("");
export const SHOWN = "Abc123";
export function newKey(mode: "live" | "test"): string {
  return ["haau3", "sk", mode, `${SHOWN}${NEW_KEY_CORE}rest`].join("_");
}
export function newKeyPrefix(mode: "live" | "test"): string {
  return ["haau3", "sk", mode, SHOWN].join("_");
}
/**
 * What would show a new key leaking, in part or in another form: the key, its marker, every six
 * characters running that reach past the prefix the keys page shows (so the prefix and one character
 * more is caught, and so is the key's tail), and the key reversed and in base64.
 */
function leaks(secret: string): string[] {
  const from = secret.indexOf(SHOWN) + SHOWN.length - 5;
  const windows: string[] = [];
  for (let i = from; i + 6 <= secret.length; i++) windows.push(secret.slice(i, i + 6));
  return [secret, ...windows, [...secret].reverse().join(""), Buffer.from(secret).toString("base64"), Buffer.from(secret).toString("base64url")];
}
export const NEW_KEY_MARKERS = [NEW_KEY_CORE, ...leaks(newKey("live")), ...leaks(newKey("test"))];

export type KeysAnswer =
  | "created"
  | "unauthorized"
  | "not-a-member"
  | "no-organization"
  | "unavailable"
  | "off"
  | "garbled"
  | "wrong-mode"
  | "bad-secret"
  | "invalid-request"
  | "no-answer"
  /** A broken platform: the key where only facts about it belong. */
  | "key-in-id"
  | "key-in-name"
  | "long-prefix"
  | "key-in-problem"
  | "server-error"
  | "ok-200";

export type TokenAnswer =
  | "pending"
  | "slow_down"
  | "expired"
  | "denied"
  | "approved"
  | "invalid_grant"
  | "server-error"
  | "not-bearer"
  | "rate-limited"
  | "pending-as-200";
export type WhoamiAnswer = "ok" | "unauthorized" | "not-a-member" | "no-organization" | "unavailable" | "garbled";

export interface Recorded {
  method: string;
  path: string;
  headers: IncomingMessage["headers"];
  body: string;
}

export const WHOAMI = {
  member: { id: "user_1", email: "dev@example.com" },
  organization: { id: "org_1", name: "Example Org", slug: "example-org" },
  role: "org:admin",
  plan: { tier: "developer", name: "Developer" },
  usage: { count: 312, allowance: 1000, headline: "312 of 1,000 requests this month" },
};

export class FakeServer {
  url = "";
  requests: Recorded[] = [];
  revoked: string[] = [];

  /** The platform's metadata: off answers 404, as a platform with sign-in from the command line off. */
  platformMetadata: "ok" | "off" | "server-error" | "other-resource" | "no-client-id" = "ok";
  /** The issuer's metadata. */
  issuerMetadata: "ok" | "other-issuer" | "foreign-endpoint" | "no-device-grant" | "missing" = "ok";
  deviceAnswer: "ok" | "invalid_client" | "bad-code" = "ok";
  /** One per poll, in order; the last one repeats. */
  tokenAnswers: TokenAnswer[] = ["approved"];
  whoamiAnswer: WhoamiAnswer = "ok";
  /** When the platform says the session ends; null means an hour after the token was handed out. */
  whoamiExpiresAt: string | null = null;
  revokeStatus = 200;
  interval: number | undefined = 5;
  expiresIn = 600;
  /** The scopes the platform's metadata lists. */
  scopes = ["user:org:read"];
  /** The organization's name whoami gives, to try what a name someone chose can hold. */
  organizationName = WHOAMI.organization.name;
  keysAnswer: KeysAnswer = "created";
  /** Runs when a key is asked for, before the answer: to change the project meanwhile. */
  onKeys: (() => void) | null = null;
  /** How many token requests were answered, the spent code's included. */
  get polls(): number {
    return this.#polls;
  }

  #server: Server | undefined;
  #polls = 0;
  #issuedAt = 0;
  /** Whether the grant behind the token is live: from an approval until a revocation. */
  #live = false;
  /** A device code is exchanged once (RFC 8628, section 3.4); after that it is invalid_grant. */
  #spent = false;

  get issuer(): string {
    return `${this.url}/issuer`;
  }

  async start(): Promise<this> {
    this.#server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
      req.on("end", () => this.#answer(req, body, res));
    });
    await new Promise<void>((resolve) => this.#server!.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.#server.address() as AddressInfo).port}`;
    return this;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.#server?.close(() => resolve()));
  }

  /** The requests to one path. */
  to(path: string): Recorded[] {
    return this.requests.filter((r) => r.path === path);
  }

  #answer(req: IncomingMessage, body: string, res: ServerResponse): void {
    const path = new URL(req.url ?? "/", this.url).pathname;
    this.requests.push({ method: req.method ?? "", path, headers: req.headers, body });
    const form = new URLSearchParams(body);
    const json = (status: number, value: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "Content-Type": "application/json", ...headers });
      res.end(JSON.stringify(value));
    };
    const problem = (status: number, code: string, headers: Record<string, string> = {}) =>
      json(status, { type: "about:blank", title: "Refused", status, detail: "Not today.", code }, { "X-Request-Id": "req_fake_1", ...headers });

    switch (path) {
      case "/.well-known/oauth-protected-resource/api/cli/v1": {
        if (this.platformMetadata === "off") return problem(404, "not-found");
        if (this.platformMetadata === "server-error") return problem(503, "unavailable", { "Retry-After": "30" });
        return json(200, {
          resource: this.platformMetadata === "other-resource" ? `${this.url}/api/other` : `${this.url}/api/cli/v1`,
          authorization_servers: [this.issuer],
          scopes_supported: this.scopes,
          bearer_methods_supported: ["header"],
          resource_name: "haau3 command line",
          ...(this.platformMetadata === "no-client-id" ? {} : { haau3_client_id: "client_fake" }),
        });
      }
      case "/.well-known/oauth-authorization-server/issuer": {
        if (this.issuerMetadata === "missing") return problem(404, "not-found");
        const foreign = this.url.replace("127.0.0.1", "localhost");
        return json(200, {
          issuer: this.issuerMetadata === "other-issuer" ? `${this.url}/someone-else` : this.issuer,
          device_authorization_endpoint: `${this.issuerMetadata === "foreign-endpoint" ? foreign : this.url}/issuer/device`,
          token_endpoint: `${this.issuer}/token`,
          revocation_endpoint: `${this.issuer}/revoke`,
          grant_types_supported: this.issuerMetadata === "no-device-grant" ? ["authorization_code"] : ["authorization_code", "urn:ietf:params:oauth:grant-type:device_code"],
        });
      }
      case "/issuer/device": {
        if (this.deviceAnswer === "invalid_client") return json(401, { error: "invalid_client" });
        this.#polls = 0;
        this.#spent = false;
        return json(200, {
          device_code: DEVICE_CODE,
          user_code: this.deviceAnswer === "bad-code" ? "no\ncontrol" : USER_CODE,
          verification_uri: `${this.url}/device`,
          verification_uri_complete: `${this.url}/device?user_code=${USER_CODE}`,
          expires_in: this.expiresIn,
          ...(this.interval === undefined ? {} : { interval: this.interval }),
        });
      }
      case "/issuer/token": {
        if (form.get("device_code") !== DEVICE_CODE || form.get("grant_type") !== "urn:ietf:params:oauth:grant-type:device_code") {
          return json(400, { error: "invalid_grant" });
        }
        if (this.#spent) {
          this.#polls++;
          return json(400, { error: "invalid_grant" });
        }
        const answer = this.tokenAnswers[Math.min(this.#polls++, this.tokenAnswers.length - 1)]!;
        if (answer === "server-error") return json(502, {});
        if (answer === "rate-limited") {
          res.writeHead(429, { "Retry-After": "30" });
          res.end();
          return;
        }
        if (answer === "pending-as-200") return json(200, { error: "authorization_pending" });
        if (answer === "approved" || answer === "not-bearer") {
          this.#issuedAt = Date.now();
          this.#live = true;
          this.#spent = true;
          return json(200, {
            access_token: ACCESS_TOKEN,
            refresh_token: REFRESH_TOKEN,
            token_type: answer === "approved" ? "Bearer" : "mac",
            expires_in: 86400,
            scope: "user:org:read offline_access",
          });
        }
        const error = { pending: "authorization_pending", slow_down: "slow_down", expired: "expired_token", denied: "access_denied", invalid_grant: "invalid_grant" }[answer];
        return json(400, { error });
      }
      case "/issuer/revoke": {
        this.revoked.push(form.get("token") ?? "");
        if (this.revokeStatus === 200 && form.get("token") === ACCESS_TOKEN) this.#live = false;
        res.writeHead(this.revokeStatus);
        res.end();
        return;
      }
      case "/api/cli/v1/whoami": {
        const challenge = { "WWW-Authenticate": `Bearer resource_metadata="${this.url}/.well-known/oauth-protected-resource/api/cli/v1"` };
        if (req.headers.authorization !== `Bearer ${ACCESS_TOKEN}` || !this.#live) return problem(401, "unauthorized", challenge);
        if (this.whoamiAnswer === "unauthorized") return problem(401, "unauthorized", challenge);
        if (this.whoamiAnswer === "not-a-member" || this.whoamiAnswer === "no-organization") return problem(403, this.whoamiAnswer);
        if (this.whoamiAnswer === "unavailable") return problem(503, "unavailable", { "Retry-After": "30" });
        if (this.whoamiAnswer === "garbled") return json(200, { member: "nobody" });
        const expiresAt = this.whoamiExpiresAt ?? new Date((this.#issuedAt || Date.now()) + 3_600_000).toISOString();
        const organization = { ...WHOAMI.organization, name: this.organizationName };
        return json(200, { ...WHOAMI, organization, session: { expiresAt } }, { "Cache-Control": "no-store" });
      }
      case "/api/cli/v1/keys": {
        const challenge = { "WWW-Authenticate": `Bearer resource_metadata="${this.url}/.well-known/oauth-protected-resource/api/cli/v1"` };
        if (this.keysAnswer === "off") return problem(404, "not-found");
        if (req.method !== "POST") return problem(405, "method-not-allowed");
        if (req.headers.authorization !== `Bearer ${ACCESS_TOKEN}` || !this.#live) return problem(401, "unauthorized", challenge);
        this.onKeys?.();
        if (this.keysAnswer === "no-answer") {
          res.destroy();
          return;
        }
        if (this.keysAnswer === "unauthorized") return problem(401, "unauthorized", challenge);
        if (this.keysAnswer === "not-a-member" || this.keysAnswer === "no-organization") return problem(403, this.keysAnswer);
        if (this.keysAnswer === "unavailable") return problem(503, "unavailable", { "Retry-After": "30" });
        if (this.keysAnswer === "invalid-request") return problem(400, "invalid-request");
        if (this.keysAnswer === "server-error") return json(500, { type: "about:blank", title: "Internal Server Error", status: 500 });
        if (this.keysAnswer === "key-in-problem") {
          const key = newKey("live");
          return json(400, { type: key, title: key, status: 400, code: "invalid-request" }, { "X-Request-Id": key });
        }
        let asked: { name?: unknown; mode?: unknown } = {};
        try {
          asked = JSON.parse(body) as typeof asked;
        } catch {
          return problem(400, "invalid-request");
        }
        const mode = asked.mode === "test" ? "test" : "live";
        const made = {
          id: "key_fake_1",
          orgId: WHOAMI.organization.id,
          name: asked.name,
          keyPrefix: newKeyPrefix(mode),
          createdBy: WHOAMI.member.id,
          createdAt: new Date().toISOString(),
          lastUsedAt: null,
          revokedAt: null,
          managed: false,
          mode,
          createdVia: "cli",
          secret: newKey(mode),
        };
        if (this.keysAnswer === "garbled") return json(201, { id: made.id, secret: made.secret });
        if (this.keysAnswer === "wrong-mode") {
          const other = mode === "live" ? "test" : "live";
          return json(201, { ...made, secret: newKey(other), keyPrefix: newKeyPrefix(other) });
        }
        if (this.keysAnswer === "bad-secret") return json(201, { ...made, secret: `${made.secret}\nEVIL=1` });
        if (this.keysAnswer === "key-in-id") return json(201, { ...made, id: made.secret });
        if (this.keysAnswer === "key-in-name") return json(201, { ...made, name: `k ${made.secret}` });
        if (this.keysAnswer === "long-prefix") return json(201, { ...made, keyPrefix: made.secret.slice(0, -1) });
        if (this.keysAnswer === "ok-200") return json(200, made);
        return json(201, made, { "Cache-Control": "no-store" });
      }
      default:
        return problem(404, "not-found");
    }
  }
}
