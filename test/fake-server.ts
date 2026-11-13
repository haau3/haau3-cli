// A stand-in for the platform and its sign-in service on one local port: the platform's
// protected-resource metadata, whoami and keys, and an authorization server under /issuer with its own
// metadata, device authorization, token and revocation endpoints. For doctor, the API's /health and
// its FHIR base's metadata answer here too, when HAAU3_BASE_URL names this server. Each answer is scripted per test,
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

/** An example's query value in the stand-in's spec: test sends it, and no output may hold it. */
export const QUERY_MARKER = ["QUERY", "MARKER", "c81f2a"].join("");

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

/** The request id on every answer from the platform, successes included, as the platform sends one. */
export const PLATFORM_REQUEST_ID = "req_fake_1";
/** The request id on every answer from the sign-in service: never the platform's, so never kept. */
export const SIGN_IN_SERVICE_REQUEST_ID = "req_signin_1";

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
export type WhoamiAnswer = "ok" | "unauthorized" | "not-a-member" | "no-organization" | "unavailable" | "garbled" | "refused";

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

/** The stand-in organization's keys, as the platform lists them: an active one, a managed one, a revoked one. */
export const LISTED_KEY_ID = "3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b";
export const MANAGED_KEY_ID = "4f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5c";
export const REVOKED_KEY_ID = "5f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5d";
export const UNKNOWN_KEY_ID = "6f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5e";
/** The listed active key's prefix, and a key that has it, for a project that uses that key. */
export const LISTED_PREFIX = ["haau3", "sk", "live", "Lst123"].join("_");
export function listedKey(rest = "ListedKeyRestOfItsFortyThreeCharactersX"): string {
  return `${LISTED_PREFIX}${rest}`;
}
export const LISTED_NAME = "laptop";

export function listedKeys(): Record<string, unknown>[] {
  const base = { orgId: WHOAMI.organization.id, createdBy: WHOAMI.member.id };
  return [
    { ...base, id: LISTED_KEY_ID, name: LISTED_NAME, keyPrefix: LISTED_PREFIX, createdAt: "2026-11-10T12:00:00.000Z", lastUsedAt: "2026-11-12T09:30:00.000Z", revokedAt: null, managed: false, mode: "live", createdVia: "cli" },
    { ...base, createdBy: null, id: MANAGED_KEY_ID, name: "Playground", keyPrefix: ["haau3", "sk", "test", "Mgd123"].join("_"), createdAt: "2026-11-01T08:00:00.000Z", lastUsedAt: null, revokedAt: null, managed: true, mode: "test", createdVia: "dashboard" },
    { ...base, id: REVOKED_KEY_ID, name: "old server", keyPrefix: ["haau3", "sk", "live", "Old123"].join("_"), createdAt: "2026-10-01T08:00:00.000Z", lastUsedAt: "2026-10-20T08:00:00.000Z", revokedAt: "2026-11-02T10:00:00.000Z", managed: false, mode: "live", createdVia: "dashboard" },
  ];
}

/** What the platform answers when keys are listed or one is read. */
export type KeyReadAnswer = "ok" | "unauthorized" | "not-a-member" | "unavailable" | "garbled" | "off" | "refused";

/** What the platform answers when a key is revoked, beyond what the stand-in's keys decide. */
export type RevokeKeyAnswer =
  | "revoked"
  /** Another request revoked it after the check: the sign-in is spent. */
  | "raced"
  /** The key went after the check: the sign-in is spent. */
  | "gone"
  | "unauthorized"
  | "not-a-member"
  | "unavailable"
  | "no-answer"
  | "garbled"
  | "refused"
  | "off";

/** What the API's metadata answers, for doctor: `echo` repeats what it was sent, as a broken server might. */
export type ApiAnswer = "ok" | "unauthorized" | "rate-limited" | "unavailable" | "echo";

export class FakeServer {
  url = "";
  apiAnswer: ApiAnswer = "ok";
  requests: Recorded[] = [];
  revoked: string[] = [];

  /** The platform's metadata: off answers 404, as a platform with sign-in from the command line off. */
  platformMetadata: "ok" | "off" | "server-error" | "refused" | "other-resource" | "no-client-id" = "ok";
  /** The issuer's metadata. */
  issuerMetadata: "ok" | "other-issuer" | "foreign-endpoint" | "no-device-grant" | "missing" | "server-error" = "ok";
  deviceAnswer: "ok" | "invalid_client" | "bad-code" | "server-error" = "ok";
  /** The request id on the platform's answers: a broken platform's may hold a secret. */
  platformRequestId = PLATFORM_REQUEST_ID;
  /** One per poll, in order; the last one repeats. */
  tokenAnswers: TokenAnswer[] = ["approved"];
  whoamiAnswer: WhoamiAnswer = "ok";
  /** When the platform says the session ends; null means an hour after the token was handed out. */
  whoamiExpiresAt: string | null = null;
  revokeStatus = 200;
  /** The revocation endpoint never answers: to hold a command to its own bound. */
  revokeHangs = false;
  /** Runs when a revocation arrives, before it is answered: to see what was done before it. */
  onRevoke: (() => void) | null = null;
  interval: number | undefined = 5;
  expiresIn = 600;
  /** The scopes the platform's metadata lists. */
  scopes = ["user:org:read"];
  /** The organization's name whoami gives, to try what a name someone chose can hold. */
  organizationName = WHOAMI.organization.name;
  keysAnswer: KeysAnswer = "created";
  /** Runs when a key is asked for, before the answer: to change the project meanwhile. */
  onKeys: (() => void) | null = null;
  /** The organization's keys, which listing, reading and revoking read and change. */
  listed: Record<string, unknown>[] = listedKeys();
  listAnswer: KeyReadAnswer = "ok";
  readAnswer: KeyReadAnswer = "ok";
  revokeKeyAnswer: RevokeKeyAnswer = "revoked";
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
    // An answer held back on purpose would keep its connection, and close() would wait for it.
    this.#server?.closeAllConnections();
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
    const fromSignInService = path.startsWith("/issuer/") || path.startsWith("/.well-known/oauth-authorization-server/");
    const requestId = { "X-Request-Id": fromSignInService ? SIGN_IN_SERVICE_REQUEST_ID : this.platformRequestId };
    const json = (status: number, value: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "Content-Type": "application/json", ...requestId, ...headers });
      res.end(JSON.stringify(value));
    };
    const problem = (status: number, code: string, headers: Record<string, string> = {}, extra: Record<string, unknown> = {}) =>
      json(status, { type: "about:blank", title: "Refused", status, detail: "Not today.", code, ...extra }, headers);
    const challenge = { "WWW-Authenticate": `Bearer resource_metadata="${this.url}/.well-known/oauth-protected-resource/api/cli/v1"` };
    const signedIn = () => req.headers.authorization === `Bearer ${ACCESS_TOKEN}` && this.#live;
    /** The scripted refusals a read of keys can meet, or false to answer it. */
    const readRefused = (answer: KeyReadAnswer): boolean => {
      if (answer === "off") return (problem(404, "not-found"), true);
      if (!signedIn() || answer === "unauthorized") return (problem(401, "unauthorized", challenge), true);
      if (answer === "not-a-member") return (problem(403, "not-a-member"), true);
      if (answer === "unavailable") return (problem(503, "unavailable", { "Retry-After": "30" }), true);
      if (answer === "refused") return (problem(400, "invalid-request"), true);
      return false;
    };

    // One key, and its revoke: the id is in the path.
    const keyPath = /^\/api\/cli\/v1\/keys\/([^/]+)(\/revoke)?$/.exec(path);
    if (keyPath) {
      const id = decodeURIComponent(keyPath[1]!);
      const key = this.listed.find((k) => k.id === id);
      if (!keyPath[2]) {
        if (req.method !== "GET") return problem(405, "method-not-allowed");
        if (readRefused(this.readAnswer)) return;
        if (!key) return problem(404, "key-not-found", {}, { signInEnded: false });
        if (this.readAnswer === "garbled") return json(200, { ...key, keyPrefix: "nope" });
        return json(200, key, { "Cache-Control": "no-store" });
      }
      if (req.method !== "POST") return problem(405, "method-not-allowed");
      const answer = this.revokeKeyAnswer;
      if (answer === "off") return problem(404, "not-found");
      if (!signedIn() || answer === "unauthorized") return problem(401, "unauthorized", challenge);
      if (answer === "not-a-member") return problem(403, "not-a-member");
      if (answer === "refused" || body !== "") return problem(400, "invalid-request");
      // The refusals that spend nothing come before the sign-in ends, as the platform orders them.
      if (!key) return problem(404, "key-not-found", {}, { signInEnded: false });
      if (key.managed === true) return problem(409, "managed-key");
      if (key.revokedAt !== null) return problem(409, "already-revoked", {}, { revokedAt: key.revokedAt, signInEnded: false });
      // From here the sign-in has ended.
      this.#live = false;
      if (answer === "no-answer") return void res.destroy();
      if (answer === "unavailable") return problem(503, "unavailable", { "Retry-After": "30" });
      if (answer === "gone") return problem(404, "key-not-found", {}, { signInEnded: true });
      const revokedAt = "2026-11-12T15:00:00.000Z";
      key.revokedAt = revokedAt;
      if (answer === "raced") return problem(409, "already-revoked", {}, { revokedAt, signInEnded: true });
      if (answer === "garbled") return json(200, { id: key.id });
      return json(200, key, { "Cache-Control": "no-store" });
    }

    switch (path) {
      case "/.well-known/oauth-protected-resource/api/cli/v1": {
        if (this.platformMetadata === "off") return problem(404, "not-found");
        if (this.platformMetadata === "server-error") return problem(503, "unavailable", { "Retry-After": "30" });
        if (this.platformMetadata === "refused") return problem(403, "forbidden");
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
        if (this.issuerMetadata === "server-error") return problem(503, "unavailable");
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
        if (this.deviceAnswer === "server-error") return problem(503, "unavailable");
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
          res.writeHead(429, { "Retry-After": "30", ...requestId });
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
        this.onRevoke?.();
        if (this.revokeHangs) return;
        if (this.revokeStatus === 200 && form.get("token") === ACCESS_TOKEN) this.#live = false;
        res.writeHead(this.revokeStatus, requestId);
        res.end();
        return;
      }
      case "/api/cli/v1/whoami": {
        if (req.headers.authorization !== `Bearer ${ACCESS_TOKEN}` || !this.#live) return problem(401, "unauthorized", challenge);
        if (this.whoamiAnswer === "unauthorized") return problem(401, "unauthorized", challenge);
        if (this.whoamiAnswer === "not-a-member" || this.whoamiAnswer === "no-organization") return problem(403, this.whoamiAnswer);
        if (this.whoamiAnswer === "unavailable") return problem(503, "unavailable", { "Retry-After": "30" });
        if (this.whoamiAnswer === "garbled") return json(200, { member: "nobody" });
        if (this.whoamiAnswer === "refused") return problem(400, "invalid-request");
        const expiresAt = this.whoamiExpiresAt ?? new Date((this.#issuedAt || Date.now()) + 3_600_000).toISOString();
        const organization = { ...WHOAMI.organization, name: this.organizationName };
        return json(200, { ...WHOAMI, organization, session: { expiresAt } }, { "Cache-Control": "no-store" });
      }
      case "/api/cli/v1/keys": {
        if (req.method === "GET") {
          if (readRefused(this.listAnswer)) return;
          const all = new URL(req.url ?? "/", this.url).searchParams.get("include") === "revoked";
          const keys = this.listed.filter((k) => all || k.revokedAt === null);
          const revokedOmitted = all ? 0 : this.listed.length - keys.length;
          if (this.listAnswer === "garbled") return json(200, { keys: [{ id: "nope" }], hasMore: false, revokedOmitted });
          return json(200, { keys, hasMore: false, revokedOmitted }, { "Cache-Control": "no-store" });
        }
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
        // The platform ends the approval before it makes a key, so from here the token is spent.
        this.#live = false;
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
      case "/health":
        return json(200, { status: "ok" });
      case "/openapi.json": {
        // For test: one service, the FHIR base's metadata, which answers as apiAnswer says. With echo,
        // the spec repeats the key sent in every name it has, in upper and lower case, and adds an
        // operation whose example query value is a marker no output may hold.
        const sent = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
        const alnum = sent.split("_").slice(3).join("").replace(/[^A-Za-z0-9]/g, "") || "none";
        const echo = this.apiAnswer === "echo";
        const ok = (type: string) => ({ "200": { description: "ok", content: { "application/fhir+json": { schema: { $ref: `#/components/schemas/${type}` } } } } });
        return json(200, {
          openapi: "3.1.0",
          info: { title: "API", version: echo ? alnum.slice(0, 40) : "1.0.0-preview.1" },
          tags: [{ name: "FHIR base" }],
          // With echo, the marker's operation comes first: metadata's 401 then stops the run.
          paths: {
            ...(echo
              ? {
                  "/v1/fhir/r4/Echo": {
                    get: { tags: ["FHIR base"], operationId: "echoQuery", parameters: [{ in: "query", name: alnum, example: QUERY_MARKER }], responses: ok("Bundle") },
                  },
                  [`/v1/fhir/r4/${alnum.toLowerCase()}`]: { get: { tags: ["FHIR base"], operationId: alnum.toUpperCase(), responses: ok(`X${alnum.toLowerCase()}`) } },
                }
              : {}),
            "/v1/fhir/r4/metadata": { get: { tags: ["FHIR base"], operationId: "fhirMetadata", responses: ok("CapabilityStatement") } },
          },
        });
      }
      case "/v1/fhir/r4/Echo":
        // The marker's operation, answered, so what test makes of a success is checked too.
        res.writeHead(200, { "Content-Type": "application/fhir+json; fhirVersion=4.0", ...requestId });
        res.end(JSON.stringify({ resourceType: "Bundle", type: "searchset", entry: [{ search: { mode: "match" } }] }));
        return;
      case "/v1/fhir/r4/metadata": {
        const fhir = (status: number, value: unknown, headers: Record<string, string> = {}) => {
          res.writeHead(status, { "Content-Type": "application/fhir+json; fhirVersion=4.0", ...requestId, ...headers });
          res.end(JSON.stringify(value));
        };
        const outcome = (code: string, diagnostics: string) => ({ resourceType: "OperationOutcome", issue: [{ severity: "error", code, diagnostics }] });
        if (this.apiAnswer === "unauthorized") return fhir(401, outcome("security", "The key was not accepted."));
        if (this.apiAnswer === "rate-limited") return fhir(429, outcome("throttled", "Slow down."), { "Retry-After": "30" });
        if (this.apiAnswer === "unavailable") return fhir(503, outcome("transient", "Starting."));
        if (this.apiAnswer === "echo") {
          const sent = String(req.headers.authorization ?? "");
          const key = sent.replace(/^Bearer /, "") || "none";
          return fhir(401, outcome("security", `You sent ${sent}`), { "X-Request-Id": key, "X-Correlation-Id": key, "Retry-After": key });
        }
        return fhir(200, { resourceType: "CapabilityStatement", status: "active" });
      }
      default:
        return problem(404, "not-found");
    }
  }
}
