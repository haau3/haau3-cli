// haau3 test against a stand-in API given as the fetch the SDK sends with: the spec it reads, the
// example requests it builds and sends, every kind of answer in text and in JSON, where each call goes
// and with which key, and that no key, body, example value or answer is ever printed.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { countOf } from "../src/commands/test.js";
import { FORMAT_VERSION } from "../src/output.js";
import { cleanEnv, fakeClock, memoryKeyring, runCli, testStore } from "./helpers.js";

// Built from parts, so no file in this repository holds a whole key-shaped string.
const LIVE = ["haau3", "sk", "live", `TESTCMDLIV${"a".repeat(33)}`].join("_");
const TEST = ["haau3", "sk", "test", `TESTCMDTST${"b".repeat(33)}`].join("_");
/** In an example's body, a path value and an answer: none may ever be printed. */
const BODY_MARKER = "BODYMARKER5f1c";
const VALUE_MARKER = "VALUEMARKER7d2e";
const ANSWER_MARKER = "ANSWERMARKER9a4b";
const MARKERS = ["TESTCMDLIV", "TESTCMDTST", BODY_MARKER, VALUE_MARKER, ANSWER_MARKER];

const PRODUCTION = "https://api.haau3.com";
const SANDBOX = "https://sandbox.haau3.com";
const REQUEST_ID = "6b1f3c2e-4d5a-4b6c-8d7e-9f0a1b2c3d4e";
const API_ERROR = "https://haau3.com/fhir/CodeSystem/api-error";

const fhirOk = (type: string) => ({ "200": { description: "ok", content: { "application/fhir+json": { schema: { $ref: `#/components/schemas/${type}` } } } } });
const jsonOk = { "200": { description: "ok", content: { "application/json": { schema: { type: "object" } } } } };
const bodyOf = (value: unknown) => ({ required: true, content: { "application/fhir+json": { examples: { one: { value } } } } });

/** One service per kind of answer, each with one operation, in this order. */
const SPEC = {
  openapi: "3.1.0",
  info: { title: "API", version: "1.0.0-preview.99" },
  tags: ["Lookups", "Searches", "Things", "Closed", "Keys", "Modes", "Records", "Refusals", "Unavailable", "Unreadable", "Incomplete", "Slow down"].map((name) => ({ name })),
  paths: {
    "/v1/fhir/r4/CodeSystem/$lookup": {
      get: { tags: ["Lookups"], operationId: "lookup", parameters: [{ in: "query", name: "code", required: true, example: "2345-7" }, { in: "query", name: "version" }], responses: fhirOk("Parameters") },
    },
    "/v1/fhir/r4/Practitioner": { get: { tags: ["Searches"], operationId: "searchPeople", parameters: [{ in: "query", name: "identifier", example: "1" }], responses: fhirOk("Bundle") } },
    "/v1/things": { get: { tags: ["Things"], operationId: "listThings", parameters: [{ in: "query", name: "limit", example: 1 }], responses: jsonOk } },
    "/v1/fhir/r4/$process-message": { post: { tags: ["Closed"], operationId: "processMessage", requestBody: bodyOf({ resourceType: "Bundle", type: "message", id: BODY_MARKER }), responses: fhirOk("Bundle") } },
    "/v1/fhir/r4/Location/{id}": {
      get: { tags: ["Keys"], operationId: "readPlace", parameters: [{ in: "path", name: "id", required: true, example: VALUE_MARKER }], responses: fhirOk("Location") },
    },
    "/v1/fhir/r4/Endpoint": { get: { tags: ["Modes"], operationId: "searchEndpoints", responses: fhirOk("Bundle") } },
    "/v1/fhir/r4/$reconcile-medications": {
      post: { tags: ["Records"], operationId: "reconcile", requestBody: bodyOf({ resourceType: "Bundle", type: "collection", id: BODY_MARKER }), responses: fhirOk("Bundle") },
    },
    "/v1/fhir/r4/Organization": { get: { tags: ["Refusals"], operationId: "searchOrgs", responses: fhirOk("Bundle") } },
    "/v1/fhir/r4/Questionnaire": { get: { tags: ["Unavailable"], operationId: "searchForms", responses: fhirOk("Bundle") } },
    "/v1/fhir/r4/InsurancePlan": { get: { tags: ["Unreadable"], operationId: "searchPlans", responses: fhirOk("Bundle") } },
    "/v1/fhir/r4/Thing/{id}": { get: { tags: ["Incomplete"], operationId: "readThing", parameters: [{ in: "path", name: "id", required: true }], responses: fhirOk("Thing") } },
    "/v1/fhir/r4/HealthcareService": { get: { tags: ["Slow down"], operationId: "searchServices", responses: fhirOk("Bundle") } },
    "/v1/fhir/r4/HealthcareService/{id}": {
      get: { tags: ["Slow down"], operationId: "readService", parameters: [{ in: "path", name: "id", required: true, example: "x" }], responses: fhirOk("HealthcareService") },
    },
  },
};

/** A spec whose every service answers. */
const PASSING = { ...SPEC, tags: SPEC.tags.slice(0, 3), paths: Object.fromEntries(Object.entries(SPEC.paths).slice(0, 3)) };

const json = (status: number, body: unknown, headers: Record<string, string> = {}, type = "application/json") =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": type, "x-request-id": REQUEST_ID, ...headers } });
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
    case `/v1/fhir/r4/Location/${VALUE_MARKER}`:
      return fhir(401, outcome("login"));
    case "/v1/fhir/r4/Endpoint":
      return fhir(403, outcome("forbidden", "test-key-outside-sandbox"));
    case "/v1/fhir/r4/$reconcile-medications":
      return fhir(403, outcome("forbidden", "phi-agreement-required"));
    case "/v1/fhir/r4/Organization":
      return fhir(404, outcome("not-found"));
    case "/v1/fhir/r4/Questionnaire":
      return fhir(503, outcome("transient"));
    case "/v1/fhir/r4/InsurancePlan":
      return fhir(200, outcome("informational"));
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

function api(spec: unknown = SPEC, answer: (url: URL) => Response | Promise<Response> = (url) => answerFor(url, spec)) {
  const sent: Sent[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    sent.push({ url, method: init?.method ?? "GET", headers: new Headers(init?.headers), body: typeof init?.body === "string" ? init.body : undefined });
    return answer(url);
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
  for (const text of [out.stdout, out.stderr]) for (const marker of MARKERS) expect(text).not.toContain(marker);
  const document = tty ? null : JSON.parse(out.stdout);
  return { ...out, document };
}

const byOperation = (document: any) => Object.fromEntries(document.data.calls.map((c: any) => [c.operation ?? "(not printed)", c]));

describe("every answer, sorted", () => {
  it("one call per service, in the spec's order, each sorted by what came back", async () => {
    const { fetch, sent } = api();
    const { code, document } = await run([], { env: { HAAU3_API_KEY: LIVE }, fetch });
    expect(code).toBe(1);
    expect(document).toMatchObject({ formatVersion: FORMAT_VERSION, command: "test", ok: false, environment: "production" });
    expect(document.error.code).toBe("calls-failed");
    const calls = byOperation(document);
    expect(Object.keys(calls)).toEqual([
      "lookup",
      "searchPeople",
      "listThings",
      "processMessage",
      "readPlace",
      "searchEndpoints",
      "reconcile",
      "searchOrgs",
      "searchForms",
      "searchPlans",
      "searchServices",
      "readThing",
    ]);
    const sorted = Object.fromEntries(Object.entries(calls).map(([op, c]: [string, any]) => [op, [c.status, c.answer]]));
    expect(sorted).toEqual({
      lookup: ["pass", "answered"],
      searchPeople: ["warn", "answered-empty"],
      listThings: ["pass", "answered"],
      processMessage: ["pass", "not-open-to-customers"],
      readPlace: ["fail", "bad-key"],
      searchEndpoints: ["fail", "wrong-key-mode"],
      reconcile: ["fail", "needs-an-agreement"],
      searchOrgs: ["fail", "refused"],
      searchForms: ["fail", "no-answer"],
      searchPlans: ["fail", "unreadable"],
      searchServices: ["warn", "over-a-limit"],
      readThing: ["fail", "not-sent"],
    });
    expect(calls.lookup.details).toMatchObject({ status: 200, requestId: REQUEST_ID, count: { what: "parameters", n: 2 }, resourceType: "Parameters" });
    expect(calls.listThings.details.count).toEqual({ what: "items", n: 1 });
    expect(calls.searchServices.details.retryAfter).toBe(30);
    expect(calls.searchOrgs.details.problem).toEqual({ type: "about:blank", title: "HTTP 404", status: 404, requestId: REQUEST_ID });
    expect(calls.processMessage.details.problem.code).toBe("not-open-to-customers");
    // Eleven calls sent and one not; the spec's read counts toward nothing.
    expect(document.data.requests).toBe(11);
    expect(sent.filter((s) => s.url.pathname !== "/openapi.json")).toHaveLength(11);
    expect(document.data.specVersion).toBe("1.0.0-preview.99");
    expect(document.data.keySent).toBe(true);
  });

  it("sends each example as the spec writes it: its parameters and body, the key, and nothing else", async () => {
    const { fetch, sent } = api();
    await run([], { env: { HAAU3_API_KEY: LIVE }, fetch });
    expect(sent[0]!.url.href).toBe(`${PRODUCTION}/openapi.json`);
    const lookup = sent.find((s) => s.url.pathname === "/v1/fhir/r4/CodeSystem/$lookup")!;
    expect([...lookup.url.searchParams]).toEqual([["code", "2345-7"]]);
    expect(lookup.headers.get("authorization")).toBe(`Bearer ${LIVE}`);
    expect(lookup.headers.get("user-agent")).toMatch(/haau3-cli\//);
    const things = sent.find((s) => s.url.pathname === "/v1/things")!;
    expect([...things.url.searchParams]).toEqual([["limit", "1"]]);
    const message = sent.find((s) => s.url.pathname === "/v1/fhir/r4/$process-message")!;
    expect(message.method).toBe("POST");
    expect(JSON.parse(message.body!)).toEqual({ resourceType: "Bundle", type: "message", id: BODY_MARKER });
    expect(sent.some((s) => s.url.pathname === "/v1/fhir/r4/Thing/{id}" || s.url.pathname.startsWith("/v1/fhir/r4/Thing"))).toBe(false);
    for (const s of sent) expect(s.url.origin).toBe(PRODUCTION);
  });

  it("stops at a 429 and lists the rest as not run", async () => {
    const { fetch, sent } = api();
    const { document } = await run(["slow-down", "--all"], { env: { HAAU3_API_KEY: LIVE }, fetch });
    expect(document.data.calls.map((c: any) => [c.operation, c.status, c.answer])).toEqual([
      ["searchServices", "warn", "over-a-limit"],
      ["readService", "skip", null],
    ]);
    expect(sent.filter((s) => s.url.pathname.startsWith("/v1/fhir/r4/HealthcareService"))).toHaveLength(1);
    expect(document.ok).toBe(true);
  });

  it("reads at a terminal: one line per call, the tally, and what it does not claim", async () => {
    const { stdout, stderr, code } = await run([], { env: { HAAU3_API_KEY: LIVE }, tty: true });
    expect(code).toBe(1);
    expect(stdout).toMatch(/^Called production at https:\/\/api\.haau3\.com with the key, from its spec 1\.0\.0-preview\.99\./);
    expect(stdout).toMatch(/ {2}pass {2}lookups +lookup +Answered 200 in \d+ ms: 2 parameters\./);
    expect(stdout).toMatch(/ {2}pass {2}closed +processMessage +Not open to customers yet \(403 not-open-to-customers\)/);
    expect(stdout).toMatch(/ {2}fail {2}keys +readPlace +The API did not take the key \(401\).*Request id: 6b1f3c2e/);
    expect(stdout).toContain("12 calls: 3 answered as documented, 2 with a warning, 7 failed. Made 11 requests. Each counts toward the organization's monthly requests");
    expect(stdout).toContain("it does not say a service is licensed, under an agreement or ready for production");
    expect(stderr).toMatch(/^7 calls failed/);
  });
});

describe("where calls go, and with which key", () => {
  it("with no key and nothing named, runs in the Sandbox with no key and says the app makes no client", async () => {
    const { fetch, sent } = api(PASSING);
    const { code, document } = await run([], { fetch });
    expect(code).toBe(0);
    expect(document.ok).toBe(true);
    expect(document.environment).toBe("sandbox");
    expect(document.data.keySent).toBe(false);
    expect(document.data.setup.status).toBe("warn");
    expect(document.data.setup.next.map((s: any) => s.command)).toEqual(["npx haau3 login", "npx haau3 keys create", expect.stringMatching(/HAAU3_ENVIRONMENT/)]);
    for (const s of sent) {
      expect(s.url.origin).toBe(SANDBOX);
      expect(s.headers.get("authorization")).toBeNull();
    }
  });

  it("with no key and production named, sends nothing", async () => {
    const { fetch, sent } = api();
    const { code, document } = await run([], { env: { HAAU3_ENVIRONMENT: "production" }, fetch });
    expect(code).toBe(1);
    expect(document.error.code).toBe("no-key");
    expect(sent).toHaveLength(0);
  });

  it("with no key, --all needs a service named, and sends nothing until it has one", async () => {
    const { fetch, sent } = api(PASSING);
    const { code, document } = await run(["--all"], { fetch });
    expect(code).toBe(2);
    expect(document.error.code).toBe("needs-a-key");
    expect(sent).toHaveLength(0);
    const one = await run(["lookups", "--all"], { fetch });
    expect(one.code).toBe(0);
  });

  it("a test key calls the Sandbox with the key, which counts toward no month", async () => {
    const { fetch, sent } = api(PASSING);
    const { stdout } = await run([], { env: { HAAU3_API_KEY: TEST }, fetch, tty: true });
    expect(stdout).toContain("Called the Sandbox at https://sandbox.haau3.com with the key");
    expect(stdout).toContain("Calls to the Sandbox with a test key count toward no month.");
    expect(sent.every((s) => s.url.origin === SANDBOX && s.headers.get("authorization") === `Bearer ${TEST}`)).toBe(true);
  });

  it("never sends the key to a host that is neither haau3's nor this computer", async () => {
    const { fetch, sent } = api(PASSING);
    const { document } = await run([], { env: { HAAU3_API_KEY: LIVE, HAAU3_BASE_URL: "https://elsewhere.example" }, fetch });
    expect(document.data.keySent).toBe(false);
    expect(document.data.setup.message).toMatch(/neither haau3's own address nor this computer, so haau3 called it with no key/);
    expect(sent.length).toBeGreaterThan(0);
    for (const s of sent) {
      expect(s.url.origin).toBe("https://elsewhere.example");
      expect(s.headers.get("authorization")).toBeNull();
    }
  });

  it("never sends a value without haau3_sk_, and says so", async () => {
    const { fetch, sent } = api();
    const { code, document } = await run([], { env: { HAAU3_API_KEY: `ghp_${"c".repeat(36)}` }, fetch });
    expect(code).toBe(1);
    expect(document.error.code).toBe("key-not-sent");
    expect(sent).toHaveLength(0);
  });

  it("reads the key from --file, as doctor does", async () => {
    writeFileSync(join(project, "app.env"), `HAAU3_API_KEY=${TEST}\n`);
    const { fetch, sent } = api(PASSING);
    const { document } = await run(["--file", "app.env"], { fetch });
    expect(document.environment).toBe("sandbox");
    expect(sent.every((s) => s.headers.get("authorization") === `Bearer ${TEST}`)).toBe(true);
  });
});

describe("the spec and the service named", () => {
  it("a spec that cannot be read stops the run before any call", async () => {
    for (const answer of [() => json(404, { title: "Not found" }), () => new Response("<html>", { status: 200, headers: { "content-type": "text/html" } }), () => json(200, { not: "a spec" })]) {
      const { fetch, sent } = api(SPEC, answer);
      const { code, document } = await run([], { env: { HAAU3_API_KEY: LIVE }, fetch });
      expect(code).toBe(1);
      expect(document.error.code).toBe("spec-unreadable");
      expect(sent).toHaveLength(1);
    }
  });

  it("an unknown service is refused, named only when it is a plain name, listing the spec's", async () => {
    const plain = await run(["nothing-here"], { env: { HAAU3_API_KEY: LIVE } });
    expect(plain.code).toBe(2);
    expect(plain.document.error).toMatchObject({ code: "unknown-service" });
    expect(plain.document.error.message).toMatch(/^haau3 test has no service named nothing-here\. The spec lists lookups, searches, things,/);
    const key = await run([LIVE], { env: { HAAU3_API_KEY: LIVE } });
    expect(key.code).toBe(2);
    expect(key.document.error.message).toBe("haau3 test has no such service.");
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
    expect(out.stdout).not.toContain("TESTCMDLIV");
  });
});

describe("countOf", () => {
  it("counts a search's matches, never an OperationOutcome beside them", () => {
    const search = { resourceType: "Bundle", type: "searchset", entry: [{ search: { mode: "match" } }, { search: { mode: "outcome" } }] };
    expect(countOf(search)).toEqual({ count: { what: "matches", n: 1 }, resourceType: "Bundle", empty: false });
    expect(countOf({ resourceType: "Bundle", type: "searchset", entry: [{ search: { mode: "outcome" } }] }).empty).toBe(true);
    expect(countOf({ resourceType: "Bundle", type: "searchset", total: 3 }).empty).toBe(false);
  });

  it("an expansion's codes, a Parameters' parameters, and a list that is not FHIR", () => {
    expect(countOf({ resourceType: "ValueSet", expansion: { total: 0 } })).toEqual({ count: { what: "codes", n: 0 }, resourceType: "ValueSet", empty: true });
    expect(countOf({ resourceType: "Parameters", parameter: [{}, {}] }).count).toEqual({ what: "parameters", n: 2 });
    expect(countOf({ slots: [], total: 0 })).toEqual({ count: { what: "items", n: 0 }, resourceType: null, empty: true });
    expect(countOf({ resourceType: "CapabilityStatement" })).toEqual({ count: null, resourceType: "CapabilityStatement", empty: false });
    expect(countOf({ resourceType: "Not\u001bplain" }).resourceType).toBeNull();
  });
});
