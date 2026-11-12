// haau3 test against a stand-in API given as the fetch the SDK sends with: the spec it reads, the
// example requests it builds and sends, every kind of answer in text and in JSON, when a run stops,
// where each call goes and with which key, and that no key, body, example value or answer is ever
// printed, in any case or spelling.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cappedFetch, countOf } from "../src/commands/test.js";
import { FORMAT_VERSION } from "../src/output.js";
import { cleanEnv, fakeClock, memoryKeyring, runCli, testStore } from "./helpers.js";

// Built from parts, so no file in this repository holds a whole key-shaped string. Each is a real
// key's length: the prefix and 43 more characters.
const LIVE = ["haau3", "sk", "live", `TESTCMDLIV${"aB3-_".repeat(6)}${"a".repeat(3)}`].join("_");
const TEST = ["haau3", "sk", "test", `TESTCMDTST${"bC4_-".repeat(6)}${"b".repeat(3)}`].join("_");
/** In an example's body, a path value, a query value and an answer: none may ever be printed. */
const BODY_MARKER = "BODYMARKER5f1c";
const VALUE_MARKER = "VALUEMARKER7d2e";
const QUERY_MARKER = "QUERYMARKER3c8a";
const ANSWER_MARKER = "ANSWERMARKER9a4b";
const MARKERS = ["TESTCMDLIV", "TESTCMDTST", "aB3-_aB3-_", "bC4_-bC4_-", BODY_MARKER, VALUE_MARKER, QUERY_MARKER, ANSWER_MARKER];

/** Throws, without repeating it, when text holds a marker in any case, or with its separators changed. */
function assertClean(text: string, where: string): void {
  const fold = (s: string) => s.toLowerCase().replace(/[-_ ]/g, "");
  const folded = fold(text);
  const hit = MARKERS.findIndex((marker) => folded.includes(fold(marker)));
  if (hit !== -1) throw new Error(`${where} shows marker number ${hit}`);
}

const PRODUCTION = "https://api.haau3.com";
const SANDBOX = "https://sandbox.haau3.com";
const REQUEST_ID = "6b1f3c2e-4d5a-4b6c-8d7e-9f0a1b2c3d4e";
const API_ERROR = "https://haau3.com/fhir/CodeSystem/api-error";

const fhirOk = (type: string) => ({ "200": { description: "ok", content: { "application/fhir+json": { schema: { $ref: `#/components/schemas/${type}` } } } } });
const jsonOk = { "200": { description: "ok", content: { "application/json": { schema: { type: "object", required: ["things", "total"] } } } } };
const bodyOf = (value: unknown) => ({ required: true, content: { "application/fhir+json": { examples: { one: { value } } } } });
const get = (tag: string, operationId: string, responses: unknown, parameters: unknown[] = []) => ({ get: { tags: [tag], operationId, parameters, responses } });
const post = (tag: string, operationId: string, body: unknown, responses: unknown) => ({ post: { tags: [tag], operationId, requestBody: bodyOf(body), responses } });

/** One service per kind of answer that does not stop a run, each with one call made by default, in this order. */
const SPEC = {
  openapi: "3.1.0",
  info: { title: "API", version: "1.0.0-preview.99" },
  tags: ["Lookups", "Searches", "Things", "Closed", "Records", "Refusals", "Unavailable", "Unreadable", "Incomplete", "Batches", "Slow down"].map((name) => ({ name })),
  paths: {
    "/v1/fhir/r4/CodeSystem/$lookup": get("Lookups", "lookup", fhirOk("Parameters"), [{ in: "query", name: "code", required: true, example: QUERY_MARKER }, { in: "query", name: "version" }]),
    "/v1/fhir/r4/Practitioner": get("Searches", "searchPeople", fhirOk("Bundle"), [{ in: "query", name: "identifier", example: "1" }]),
    "/v1/things": get("Things", "listThings", jsonOk, [{ in: "query", name: "limit", example: 1 }]),
    "/v1/fhir/r4/$process-message": post("Closed", "processMessage", { resourceType: "Bundle", type: "message", id: BODY_MARKER }, fhirOk("Bundle")),
    "/v1/fhir/r4/$reconcile-medications": post("Records", "reconcile", { resourceType: "Bundle", type: "collection", id: BODY_MARKER }, fhirOk("Bundle")),
    "/v1/fhir/r4/Organization": get("Refusals", "searchOrgs", fhirOk("Bundle")),
    "/v1/fhir/r4/Questionnaire": get("Unavailable", "searchForms", fhirOk("Bundle")),
    "/v1/fhir/r4/InsurancePlan": get("Unreadable", "searchPlans", fhirOk("Bundle")),
    "/v1/fhir/r4/Thing/{id}": get("Incomplete", "readThing", fhirOk("Thing"), [{ in: "path", name: "id", required: true }]),
    "/v1/fhir/r4/Thing": get("Incomplete", "searchThings", fhirOk("Bundle")),
    "/v1/fhir/r4": post("Batches", "fhirBatch", { resourceType: "Bundle", type: "batch", entry: [{}, {}, {}] }, fhirOk("Bundle")),
    "/v1/fhir/r4/HealthcareService": get("Slow down", "searchServices", fhirOk("Bundle")),
    "/v1/fhir/r4/HealthcareService/{id}": get("Slow down", "readService", fhirOk("HealthcareService"), [{ in: "path", name: "id", required: true, example: VALUE_MARKER }]),
  },
};

/** A spec whose services answer, without stopping a run. */
const PASSING = { ...SPEC, tags: SPEC.tags.slice(0, 3), paths: Object.fromEntries(Object.entries(SPEC.paths).slice(0, 3)) };

/** A spec of one service whose first call stops the run, and whose second is never sent. */
const stopper = (first: Record<string, unknown>) => ({
  ...SPEC,
  tags: [{ name: "Stops" }],
  paths: {
    "/v1/fhir/r4/Location": { get: { ...(first as { get: object }).get, tags: ["Stops"], operationId: "first" } },
    "/v1/fhir/r4/Location/{id}": get("Stops", "second", fhirOk("Location"), [{ in: "path", name: "id", required: true, example: VALUE_MARKER }]),
  },
});

const json = (status: number, body: unknown, headers: Record<string, string> = {}, type = "application/json") =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    statusText: `STATUS ${ANSWER_MARKER}`,
    headers: { "content-type": type, "x-request-id": REQUEST_ID, "x-correlation-id": ANSWER_MARKER, "x-other": ANSWER_MARKER, ...headers },
  });
const fhir = (status: number, body: unknown, headers: Record<string, string> = {}) => json(status, body, headers, "application/fhir+json; fhirVersion=4.0");
const outcome = (code: string, apiCode?: string) => ({
  resourceType: "OperationOutcome",
  issue: [{ severity: "error", code, details: { text: `The API's own words, ${ANSWER_MARKER}.`, ...(apiCode ? { coding: [{ system: API_ERROR, code: apiCode }] } : {}) } }],
});

/** What the stand-in answers at each path. */
function answerFor(url: URL, spec: unknown): Response {
  switch (url.pathname) {
    case "/openapi.json":
      return json(200, spec);
    case "/v1/fhir/r4/CodeSystem/$lookup":
      return fhir(200, { resourceType: "Parameters", parameter: [{ name: "display", valueString: ANSWER_MARKER }, { name: "code" }] });
    case "/v1/fhir/r4/Practitioner":
      return fhir(200, { resourceType: "Bundle", type: "searchset", entry: [] });
    case "/v1/things":
      return json(200, { things: [{ name: ANSWER_MARKER }], total: 1 });
    case "/v1/fhir/r4/$process-message":
      return fhir(403, outcome("forbidden", "not-open-to-customers"));
    case "/v1/fhir/r4/$reconcile-medications":
      return fhir(403, outcome("forbidden", "phi-agreement-required"));
    case "/v1/fhir/r4/Organization":
      return fhir(404, outcome("not-found"));
    case "/v1/fhir/r4/Questionnaire":
      return fhir(503, outcome("transient"), { "retry-after": ANSWER_MARKER });
    case "/v1/fhir/r4/InsurancePlan":
      return fhir(200, outcome("informational"));
    case "/v1/fhir/r4/Thing":
      return fhir(200, { resourceType: "Bundle", type: "searchset", entry: [{ search: { mode: "match" } }] });
    case "/v1/fhir/r4":
      return fhir(200, { resourceType: "Bundle", type: "batch-response", entry: [{ response: { status: "200 OK" } }, { response: { status: "404 Not Found" } }, { response: { status: "500" } }] });
    case "/v1/fhir/r4/HealthcareService":
      return fhir(429, outcome("throttled"), { "retry-after": "30" });
    default:
      return fhir(404, outcome("not-found"));
  }
}

interface Sent {
  url: URL;
  method: string;
  headers: Headers;
  body: string | undefined;
}

function api(spec: unknown = SPEC, answer: (url: URL, sent: Sent) => Response | Promise<Response> = (url) => answerFor(url, spec)) {
  const sent: Sent[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const one = { url, method: init?.method ?? "GET", headers: new Headers(init?.headers), body: typeof init?.body === "string" ? init.body : undefined };
    sent.push(one);
    return answer(url, one);
  }) as typeof globalThis.fetch;
  return { fetch, sent };
}

let project: string;
let dir: string;
beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), "cli-test-project-"));
  dir = mkdtempSync(join(tmpdir(), "cli-test-store-"));
});
afterEach(() => {
  rmSync(project, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
});

async function run(args: string[], { env = {}, fetch = api().fetch, tty = false }: { env?: NodeJS.ProcessEnv; fetch?: typeof globalThis.fetch; tty?: boolean } = {}) {
  const fullEnv = cleanEnv({ HAAU3_PLATFORM_URL: "http://127.0.0.1:59998", ...env });
  const out = await runCli(["test", ...args], { tty, env: fullEnv, cwd: project, io: { fetch, store: testStore(dir, memoryKeyring(), fullEnv), ...fakeClock() } });
  assertClean(out.stdout, "stdout");
  assertClean(out.stderr, "stderr");
  const document = tty ? null : JSON.parse(out.stdout);
  return { ...out, document };
}

const sorted = (document: any) => document.data.calls.map((c: any) => [c.operation, c.status, c.answer]);

describe("every answer, sorted", () => {
  it("one call per service, in the spec's order, each sorted by what came back", async () => {
    const { fetch, sent } = api();
    const { code, document } = await run([], { env: { HAAU3_API_KEY: LIVE }, fetch });
    expect(code).toBe(1);
    expect(document).toMatchObject({ formatVersion: FORMAT_VERSION, command: "test", ok: false, environment: "production" });
    expect(document.error.code).toBe("calls-failed");
    expect(sorted(document)).toEqual([
      ["lookup", "pass", "answered"],
      ["searchPeople", "warn", "answered-empty"],
      ["listThings", "pass", "answered"],
      ["processMessage", "pass", "not-open-to-customers"],
      ["reconcile", "fail", "needs-an-agreement"],
      ["searchOrgs", "fail", "refused"],
      ["searchForms", "fail", "no-answer"],
      ["searchPlans", "fail", "unreadable"],
      // The service's first operation cannot be built: it is reported, never swapped for the second.
      ["readThing", "fail", "not-sent"],
      ["fhirBatch", "fail", "refused"],
      ["searchServices", "warn", "over-a-limit"],
    ]);
    const calls = Object.fromEntries(document.data.calls.map((c: any) => [c.operation, c]));
    expect(calls.lookup.details).toMatchObject({ status: 200, requestId: REQUEST_ID, count: { what: "parameters", n: 2 }, resourceType: "Parameters" });
    expect(calls.listThings.details.count).toEqual({ what: "items", n: 1 });
    expect(calls.fhirBatch.details.batch).toEqual({ answered: 1, total: 3, limited: false, statuses: ["200", "404", "500"] });
    expect(calls.fhirBatch.message).toBe("Answered 200, but 2 of 3 entries were not answered (200, 404, 500). The batch is the spec's own example.");
    expect(calls.searchServices.details.retryAfter).toBe(30);
    expect(calls.searchOrgs.details.problem).toEqual({ type: "about:blank", title: "HTTP 404", status: 404, requestId: REQUEST_ID });
    expect(calls.processMessage.details.problem.code).toBe("not-open-to-customers");
    // Answered calls count, a batch by its entries; a 429 and what was never sent count nothing.
    expect(document.data.requests).toBe(11);
    expect(sent.filter((s) => s.url.pathname !== "/openapi.json")).toHaveLength(10);
    expect(document.data.specVersion).toBe("1.0.0-preview.99");
    expect(document.data.keySent).toBe(true);
  });

  it("sends each example as the spec writes it: its parameters and body, the key, and nothing else", async () => {
    const { fetch, sent } = api();
    await run([], { env: { HAAU3_API_KEY: LIVE }, fetch });
    expect(sent[0]!.url.href).toBe(`${PRODUCTION}/openapi.json`);
    const lookup = sent.find((s) => s.url.pathname === "/v1/fhir/r4/CodeSystem/$lookup")!;
    expect([...lookup.url.searchParams]).toEqual([["code", QUERY_MARKER]]);
    expect(lookup.headers.get("authorization")).toBe(`Bearer ${LIVE}`);
    expect(lookup.headers.get("user-agent")).toMatch(/haau3-cli\//);
    expect([...sent.find((s) => s.url.pathname === "/v1/things")!.url.searchParams]).toEqual([["limit", "1"]]);
    const message = sent.find((s) => s.url.pathname === "/v1/fhir/r4/$process-message")!;
    expect(message.method).toBe("POST");
    expect(JSON.parse(message.body!)).toEqual({ resourceType: "Bundle", type: "message", id: BODY_MARKER });
    expect(sent.some((s) => s.url.pathname.startsWith("/v1/fhir/r4/Thing"))).toBe(false);
    for (const s of sent) expect(s.url.origin).toBe(PRODUCTION);
  });

  it("an answer documented as plain JSON must hold what its schema requires", async () => {
    const { fetch } = api(PASSING, (url) => (url.pathname === "/v1/things" ? json(200, { things: [] }) : answerFor(url, PASSING)));
    const { document } = await run(["things"], { env: { HAAU3_API_KEY: LIVE }, fetch });
    expect(sorted(document)).toEqual([["listThings", "fail", "unreadable"]]);
    for (const body of [null, [], "an error page"]) {
      const other = api(PASSING, (url) => (url.pathname === "/v1/things" ? json(200, body) : answerFor(url, PASSING)));
      const out = await run(["things"], { env: { HAAU3_API_KEY: LIVE }, fetch: other.fetch });
      expect(sorted(out.document)[0][2]).toBe("unreadable");
    }
  });

  it("not open to customers passes in production only", async () => {
    const closed = { ...SPEC, tags: [{ name: "Closed" }], paths: { "/v1/fhir/r4/$process-message": SPEC.paths["/v1/fhir/r4/$process-message"] } };
    const sandbox = await run([], { env: { HAAU3_API_KEY: TEST }, fetch: api(closed).fetch });
    expect(sorted(sandbox.document)).toEqual([["processMessage", "fail", "not-open-to-customers"]]);
    const production = await run([], { env: { HAAU3_API_KEY: LIVE }, fetch: api(closed).fetch });
    expect(sorted(production.document)).toEqual([["processMessage", "pass", "not-open-to-customers"]]);
    expect(production.code).toBe(0);
  });

  it("sorts the Sandbox's not-the-example by its code, from the FHIR base and from a problem", async () => {
    const notTheExample = {
      resourceType: "OperationOutcome",
      issue: [{ severity: "error", code: "business-rule", details: { coding: [{ system: "https://haau3.com/fhir/CodeSystem/sandbox-error", code: "not-the-example" }] } }],
    };
    for (const respond of [() => fhir(400, notTheExample), () => json(400, { type: "about:blank", title: "Invalid request", status: 400, code: "not-the-example" })]) {
      const { fetch } = api(PASSING, (url) => (url.pathname === "/openapi.json" ? json(200, PASSING) : respond()));
      const { document } = await run(["lookups"], { env: { HAAU3_API_KEY: TEST }, fetch });
      expect(document.data.calls[0]).toMatchObject({ status: "fail", answer: "not-the-example" });
      expect(document.data.calls[0].details.problem.code).toBe("not-the-example");
    }
  });

  it("reads at a terminal: one line per call, the tally, and what it does not claim", async () => {
    const { stdout, stderr, code } = await run([], { env: { HAAU3_API_KEY: LIVE }, tty: true });
    expect(code).toBe(1);
    expect(stdout).toMatch(/^Called production at https:\/\/api\.haau3\.com with the key, from its spec 1\.0\.0-preview\.99\./);
    expect(stdout).toMatch(/ {2}pass {2}lookups +lookup +Answered 200 in \d+ ms: 2 parameters\./);
    expect(stdout).toMatch(/ {2}pass {2}closed +processMessage +Not open to customers yet \(403 not-open-to-customers\)/);
    expect(stdout).toMatch(/ {2}fail {2}refusals +searchOrgs +Refused \(404\).*Request id: 6b1f3c2e/);
    expect(stdout).toContain("11 calls: 3 answered as documented, 2 with a warning, 6 failed. Made 11 requests. Each counts toward the organization's monthly requests");
    expect(stdout).toContain("it does not say a service is licensed, under an agreement or ready for production");
    expect(stderr).toMatch(/^6 calls failed/);
  });
});

describe("when a run stops", () => {
  it.each([
    ["a 429", fhir(429, outcome("throttled"), { "retry-after": "30" }), "warn", "over-a-limit", "Not run: the API said to slow down."],
    ["a key the API refused", fhir(401, outcome("login")), "fail", "bad-key", "Not run: the API refused the key."],
    ["a key in the wrong mode", fhir(403, outcome("forbidden", "test-key-outside-sandbox")), "fail", "wrong-key-mode", "Not run: the API refused the key."],
  ])("at %s, listing the rest as not run", async (_what, answer, status, kind, skipped) => {
    const spec = stopper(get("Stops", "first", fhirOk("Bundle")));
    const { fetch, sent } = api(spec, (url) => (url.pathname === "/openapi.json" ? json(200, spec) : answer.clone()));
    const { code, document } = await run(["stops", "--all"], { env: { HAAU3_API_KEY: LIVE }, fetch });
    expect(sorted(document)).toEqual([
      ["first", status, kind],
      ["second", "skip", null],
    ]);
    expect(document.data.calls[1].message).toBe(skipped);
    expect(sent.filter((s) => s.url.pathname !== "/openapi.json")).toHaveLength(1);
    expect(code).toBe(1);
  });

  it("at a host that cannot be reached", async () => {
    const spec = stopper(get("Stops", "first", fhirOk("Bundle")));
    const { fetch, sent } = api(spec, (url) => {
      if (url.pathname === "/openapi.json") return json(200, spec);
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
    });
    const { document } = await run(["stops", "--all"], { env: { HAAU3_API_KEY: LIVE }, fetch });
    expect(sorted(document)).toEqual([
      ["first", "fail", "unreachable"],
      ["second", "skip", null],
    ]);
    expect(sent).toHaveLength(2);
  });

  it("at a batch entry over a limit", async () => {
    const spec = { ...SPEC, tags: [{ name: "Batches" }], paths: { "/v1/fhir/r4": SPEC.paths["/v1/fhir/r4"], "/v1/fhir/r4/Thing": get("Batches", "after", fhirOk("Bundle")) } };
    const { fetch } = api(spec, (url) =>
      url.pathname === "/openapi.json" ? json(200, spec) : fhir(200, { resourceType: "Bundle", type: "batch-response", entry: [{ response: { status: "429" } }] }),
    );
    const { document } = await run(["batches", "--all"], { env: { HAAU3_API_KEY: LIVE }, fetch });
    expect(sorted(document)).toEqual([
      ["fhirBatch", "warn", "over-a-limit"],
      ["after", "skip", null],
    ]);
  });

  it("a run that answered nothing exits 1, and the tally names what was not run", async () => {
    const spec = stopper(get("Stops", "first", fhirOk("Bundle")));
    const { fetch } = api(spec, (url) => (url.pathname === "/openapi.json" ? json(200, spec) : fhir(429, outcome("throttled"), { "retry-after": "30" })));
    const { code, document } = await run(["stops", "--all"], { fetch });
    expect(code).toBe(1);
    expect(document.ok).toBe(false);
    expect(document.error.code).toBe("nothing-answered");
    const text = await run(["stops", "--all"], { fetch, tty: true });
    expect(text.stdout).toContain("2 calls: 0 answered as documented, 1 with a warning, 1 not run. Made 0 requests.");
  });
});

describe("where calls go, and with which key", () => {
  it("with no key and nothing named, runs in the Sandbox with no key and says the app makes no client", async () => {
    const { fetch, sent } = api(PASSING);
    const { code, document } = await run([], { fetch });
    expect(code).toBe(0);
    expect(document.environment).toBe("sandbox");
    expect(document.data.keySent).toBe(false);
    expect(document.data.setup.message).toMatch(/^No API key was found, so this ran in the Sandbox with no key\./);
    // The Sandbox first: the app can call it as it is, with HAAU3_ENVIRONMENT set; a live key takes a sign-in.
    expect(document.data.setup.next.map((s: any) => s.command)).toEqual([expect.stringMatching(/HAAU3_ENVIRONMENT/), "npx haau3 login", "npx haau3 keys create"]);
    expect(document.data.setup.message).toContain("set HAAU3_ENVIRONMENT=sandbox where it reads its settings, or sign in and make a key.");
    for (const s of sent) {
      expect(s.url.origin).toBe(SANDBOX);
      expect(s.headers.get("authorization")).toBeNull();
    }
  });

  it("names where the calls went, and no environment, when the address is not an environment's own", async () => {
    const { fetch } = api(PASSING);
    const keyless = await run([], { env: { HAAU3_BASE_URL: "http://127.0.0.1:9" }, fetch });
    expect(keyless.document.environment).toBeNull();
    expect(keyless.document.data.setup.message).toMatch(/^No API key was found, so this ran at http:\/\/127\.0\.0\.1:9 with no key\./);
    const kept = await run([], { env: { HAAU3_API_KEY: LIVE, HAAU3_BASE_URL: "https://elsewhere.example" }, fetch });
    expect(kept.document.environment).toBeNull();
    expect(kept.document.data.keySent).toBe(false);
  });

  it("with no key and production named, sends nothing", async () => {
    const { fetch, sent } = api();
    const { code, document } = await run([], { env: { HAAU3_ENVIRONMENT: "production" }, fetch });
    expect(code).toBe(1);
    expect(document.error.code).toBe("no-key");
    expect(sent).toHaveLength(0);
    // Production named on purpose: a key for it first, and the Sandbox last.
    expect(document.error.next.map((s: any) => s.command)).toEqual(["npx haau3 login", "npx haau3 keys create", expect.stringMatching(/HAAU3_ENVIRONMENT/)]);
  });

  it("with no key, --all needs a service named, and sends nothing until it has one", async () => {
    const { fetch, sent } = api(PASSING);
    const { code, document } = await run(["--all"], { fetch });
    expect(code).toBe(2);
    expect(document.error.code).toBe("needs-a-key");
    expect(sent).toHaveLength(0);
    expect((await run(["lookups", "--all"], { fetch })).code).toBe(0);
  });

  it("a test key calls the Sandbox with the key, which counts toward no month", async () => {
    const { fetch, sent } = api(PASSING);
    const { stdout } = await run([], { env: { HAAU3_API_KEY: TEST }, fetch, tty: true });
    expect(stdout).toContain("Called the Sandbox at https://sandbox.haau3.com with the key");
    expect(stdout).toContain("Calls to the Sandbox with a test key count toward no month.");
    expect(sent.every((s) => s.url.origin === SANDBOX && s.headers.get("authorization") === `Bearer ${TEST}`)).toBe(true);
  });

  it("never sends the key to a host that is neither haau3's nor this computer, nor to one ending in a dot", async () => {
    const { fetch, sent } = api(PASSING);
    const { document } = await run([], { env: { HAAU3_API_KEY: LIVE, HAAU3_BASE_URL: "https://elsewhere.example" }, fetch });
    expect(document.data.setup.message).toMatch(/neither haau3's own address nor this computer, so haau3 called it with no key/);
    for (const s of sent) expect(s.headers.get("authorization")).toBeNull();
    const dotted = api(PASSING);
    const out = await run([], { env: { HAAU3_API_KEY: LIVE, HAAU3_BASE_URL: "https://api.haau3.com." }, fetch: dotted.fetch });
    expect(out.document.error.code).toBe("bad-settings");
    expect(dotted.sent).toHaveLength(0);
  });

  it("never sends a value without haau3_sk_, and says so", async () => {
    const { fetch, sent } = api();
    const { code, document } = await run([], { env: { HAAU3_API_KEY: `ghp_${"c".repeat(36)}` }, fetch });
    expect(code).toBe(1);
    expect(document.error.code).toBe("key-not-sent");
    expect(sent).toHaveLength(0);
  });

  it("reads the key from --file, and stops when --file names a file it cannot read", async () => {
    writeFileSync(join(project, "app.env"), `HAAU3_API_KEY=${TEST}\n`);
    const { fetch, sent } = api(PASSING);
    const { document } = await run(["--file", "app.env"], { fetch });
    expect(document.environment).toBe("sandbox");
    expect(sent.every((s) => s.headers.get("authorization") === `Bearer ${TEST}`)).toBe(true);
    const missing = api(PASSING);
    const out = await run(["--file", "typo.env"], { fetch: missing.fetch });
    expect(out.code).toBe(1);
    expect(out.document.error).toMatchObject({ code: "file-not-read", message: "--file names typo.env, which does not exist. Nothing was sent." });
    expect(missing.sent).toHaveLength(0);
  });
});

describe("a host that repeats the key", () => {
  it("never gets it printed: not from a spec's names, a resource type or a code, in any case", async () => {
    // A stand-in on this computer, where the key may go, reflecting it into everything it answers.
    const random = (key: string) => key.split("_").slice(3).join("_");
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const key = random(String(new Headers(init?.headers).get("authorization") ?? "").replace(/^Bearer /, ""));
      const alnum = key.replace(/[^A-Za-z0-9]/g, "");
      if (url.pathname === "/openapi.json") {
        return json(200, {
          openapi: "3.1.0",
          info: { version: alnum.slice(0, 30) },
          tags: [{ name: "Echo" }, { name: alnum.slice(0, 30) }],
          paths: {
            [`/v1/${alnum}`]: get("Echo", "byPath", fhirOk("Bundle")),
            "/v1/a": get("Echo", alnum.toUpperCase(), fhirOk("Bundle")),
            "/v1/b": get("Echo", "byParameter", fhirOk("Bundle"), [{ in: "query", name: alnum, required: true }]),
            "/v1/c": get("Echo", "byType", fhirOk(alnum.slice(0, 1).toUpperCase() + alnum.slice(1).replace(/[0-9]/g, "x"))),
            "/v1/d": get("Echo", "byCode", fhirOk("Bundle")),
            "/v1/e": get(alnum.slice(0, 30), "byTag", fhirOk("Bundle")),
          },
        });
      }
      if (url.pathname === "/v1/d") return fhir(403, outcome("forbidden", alnum.toLowerCase()));
      return fhir(200, { resourceType: alnum.slice(0, 1).toUpperCase() + alnum.slice(1).replace(/[0-9]/g, "x"), entry: [] });
    }) as typeof globalThis.fetch;
    for (const tty of [true, false]) {
      // run() checks every output for the key in any case or spelling.
      await run(["echo", "--all"], { env: { HAAU3_API_KEY: LIVE, HAAU3_BASE_URL: "http://127.0.0.1:9" }, fetch, tty });
    }
  });
});

describe("the spec and the service named", () => {
  it("a spec that cannot be read stops the run before any call", async () => {
    for (const answer of [
      () => json(404, { title: "Not found" }),
      () => new Response("<html>", { status: 200, headers: { "content-type": "text/html" } }),
      () => json(200, { not: "a spec" }),
      () => json(200, { openapi: "3.0.0", paths: {} }),
    ]) {
      const { fetch, sent } = api(SPEC, answer);
      const { code, document } = await run([], { env: { HAAU3_API_KEY: LIVE }, fetch });
      expect(code).toBe(1);
      expect(document.error.code).toBe("spec-unreadable");
      expect(sent).toHaveLength(1);
    }
  });

  it("a spec larger than an API's is not read past its size", async () => {
    const { fetch } = api(SPEC, () => json(200, "x", { "content-length": String(64 * 1024 * 1024) }));
    const { document } = await run([], { env: { HAAU3_API_KEY: LIVE }, fetch });
    expect(document.error.code).toBe("spec-unreadable");
    expect(document.error.message).toMatch(/answered with more than an API's spec holds/);
  });

  it("an unknown service is refused, never repeated, listing the spec's", async () => {
    // A key cut to the 41 characters a service name may have, built from parts like every key here.
    const cut = ["haau3", "sk", "live", "zk3vq9xt2mlp8rwy5nbc7hdj4s"].join("_");
    for (const typed of ["nothing-here", cut, "Short"]) {
      const out = await run([typed], { env: { HAAU3_API_KEY: LIVE } });
      expect(out.code).toBe(2);
      expect(out.document.error.code).toBe("unknown-service");
      expect(out.document.error.message).toMatch(/^haau3 test has no such service\. The spec lists lookups, searches, things,/);
      expect(out.stdout.toLowerCase()).not.toContain(typed.toLowerCase().replace(/_/g, "-"));
    }
  });

  it("takes a tag's own name, in any case", async () => {
    const { document } = await run(["Slow down"], { env: { HAAU3_API_KEY: LIVE } });
    expect(document.data.service).toBe("slow-down");
    expect(document.data.calls.map((c: any) => c.operation)).toEqual(["searchServices"]);
  });

  it("says the Sandbox is an environment, not a service", async () => {
    const { code, document } = await run(["sandbox"], { env: { HAAU3_API_KEY: LIVE } });
    expect(code).toBe(2);
    expect(document.error.code).toBe("sandbox-is-an-environment");
  });

  it("takes one argument, and never repeats a second", async () => {
    const out = await runCli(["test", "lookups", LIVE], { env: cleanEnv({}), cwd: project });
    expect(out.code).toBe(2);
    expect(JSON.parse(out.stdout).error).toMatchObject({ code: "unexpected-argument", message: "haau3 test takes one argument." });
    assertClean(out.stdout, "stdout");
  });
});

describe("cappedFetch", () => {
  const body = (bytes: number) => new Response(new Uint8Array(bytes).fill(120), { status: 200, statusText: "OK", headers: { "x-kept": "1" } });

  it("passes an answer within the limit through, its status and headers kept", async () => {
    const res = await cappedFetch(async () => body(10), 16)("http://127.0.0.1:9/x");
    expect(res.status).toBe(200);
    expect(res.headers.get("x-kept")).toBe("1");
    expect(await res.text()).toBe("x".repeat(10));
  });

  it("refuses one whose length says it is too large, and stops reading one that turns out to be", async () => {
    const said = new Response("x", { headers: { "content-length": "100" } });
    await expect(cappedFetch(async () => said, 16)("http://127.0.0.1:9/x")).rejects.toMatchObject({ code: "HAAU3_SPEC_TOO_LARGE" });
    await expect(cappedFetch(async () => body(17), 16)("http://127.0.0.1:9/x")).rejects.toMatchObject({ code: "HAAU3_SPEC_TOO_LARGE" });
  });
});

describe("countOf", () => {
  it("counts a search's matches, never an OperationOutcome beside them, and a total with no entries", () => {
    const search = { resourceType: "Bundle", type: "searchset", entry: [{ search: { mode: "match" } }, { search: { mode: "outcome" } }] };
    expect(countOf(search)).toMatchObject({ count: { what: "matches", n: 1 }, resourceType: "Bundle", empty: false });
    expect(countOf({ resourceType: "Bundle", type: "searchset", entry: [{ search: { mode: "outcome" } }] }).empty).toBe(true);
    expect(countOf({ resourceType: "Bundle", type: "searchset", total: 3 })).toMatchObject({ count: { what: "matches", n: 3 }, empty: false });
  });

  it("an expansion's codes, a Parameters' parameters, and a list that is not FHIR", () => {
    expect(countOf({ resourceType: "ValueSet", expansion: { total: 0 } })).toMatchObject({ count: { what: "codes", n: 0 }, empty: true });
    expect(countOf({ resourceType: "ValueSet", expansion: { total: 0, contains: [{}, {}] } })).toMatchObject({ count: { what: "codes", n: 2 }, empty: false });
    expect(countOf({ resourceType: "Parameters", parameter: [{}, {}] }).count).toEqual({ what: "parameters", n: 2 });
    expect(countOf({ slots: [], total: 0 })).toMatchObject({ count: { what: "items", n: 0 }, resourceType: null, empty: true });
    expect(countOf({ resourceType: "CapabilityStatement" })).toMatchObject({ count: null, resourceType: "CapabilityStatement", empty: false });
    expect(countOf({ resourceType: "Not\u001bplain" }).resourceType).toBeNull();
  });

  it("takes only a whole, non-negative total", () => {
    for (const total of [-7, 0.5, Number.POSITIVE_INFINITY, "3"]) {
      expect(countOf({ resourceType: "ValueSet", expansion: { total, contains: [{}] } }).count).toEqual({ what: "codes", n: 1 });
    }
  });

  it("a batch's entries, and which were answered", () => {
    const batch = { resourceType: "Bundle", type: "batch-response", entry: [{ response: { status: "200 OK" } }, { response: { status: "429 Too Many" } }, {}] };
    expect(countOf(batch).batch).toEqual({ answered: 1, total: 3, limited: true, statuses: ["200", "429", "???"] });
  });
});
