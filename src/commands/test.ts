// `haau3 test [service]`: one safe call per service, built from the published spec's own examples,
// and what kind of answer came back. It reads the spec from the host the calls go to, sends each
// operation's documented example and nothing else, and reports only the status, the request id, the
// timing and a count: never a body, an example's value, or the answer's words.
//
// Where calls go is doctor's: the settings where the application finds them, and the SDK picks the
// host. With no key and nothing named it runs in the Sandbox with no key, and says the app as set up
// makes no client. A key goes only to haau3's own two addresses or to this computer.
import type { Haau3 } from "@haau3/sdk";
import { CALL_TIMEOUT_MS, COLD_START, keyFacts, keyMayGo, NAMED, safeRequestId, shownBase, showsKey, sortError, type Sorted } from "../calls.js";
import { keylessClient, makeClient, namedEnvironment, type ClientMade } from "../client.js";
import { fileFlagError } from "../envfile.js";
import { ENVIRONMENT_ADDRESSES, type Environment } from "../environment.js";
import { failure, success, EXIT, type NextStep, type Problem } from "../output.js";
import { BASE_URL_VARIABLE, ENVIRONMENT_VARIABLE, findSettings, KEY_VARIABLE, where, type Settings } from "../settings.js";
import { MAX_SPEC_BYTES, readSpec, serviceName, type ExampleRequest, type Operation, type Service } from "../spec.js";
import {
  doctorStep,
  fileFlag,
  KEYS_CREATE_STEP,
  keysCreateStep,
  LOGIN_STEP,
  misused,
  sandboxStep,
  type Context,
  type Result,
} from "./context.js";

const COMMAND = "test";

export interface TestOptions {
  /** The service named, as typed: `terminology`, `provider-directory`, or a tag's own name. */
  service: string | undefined;
  /** Every operation of the services run, not only the first. */
  all: boolean;
  /** An env file to read in place of .env.local and .env, as given with --file. */
  file: string | undefined;
}

/** What kind of answer a call got: an answer, or one of the refusals doctor and test share. */
export type Answer = "answered" | "answered-empty" | Sorted["answer"];
export type CallStatus = "pass" | "warn" | "fail" | "skip";

export interface Count {
  what: "matches" | "entries" | "parameters" | "codes" | "items";
  n: number;
}

export interface CallReport {
  service: string;
  /** The operation's id, or null when the spec's is not a plain name. */
  operation: string | null;
  method: "GET" | "POST" | null;
  /** The path as the spec writes it, `{id}` left in: never a value sent. */
  path: string | null;
  status: CallStatus;
  /** What kind of answer came back; null for a call not run. */
  answer: Answer | null;
  message: string;
  next: NextStep[];
  /** For a program: the status, the request id, the timing and a count. Never a body. */
  details: Record<string, unknown>;
}

/** A name a person typed for a service: matched against the spec's, never repeated back. */
const TYPED_SERVICE = /^[A-Za-z][A-Za-z0-9 _-]{0,40}$/;
const PLAIN_TYPE = /^[A-Z][A-Za-z]{0,63}$/;
const REPORT_STEP = { command: "npx haau3@latest --version", description: "Check for a newer version, then report it at https://github.com/haau3/haau3-cli/issues." };

/** The command that runs this again, with the same service, --all and --file. */
function rerunStep(options: TestOptions, service: string | null): NextStep {
  const parts = ["npx haau3 test"];
  if (service) parts.push(service);
  if (options.all) parts.push("--all");
  if (options.file !== undefined) parts.push(fileFlag(options.file));
  return { command: parts.join(" "), description: "Run the same calls again." };
}

/** Each command once, in the order given. */
function steps(lists: NextStep[][]): NextStep[] {
  const seen = new Set<string>();
  const out: NextStep[] = [];
  for (const list of lists) {
    for (const step of list) {
      if (seen.has(step.command)) continue;
      seen.add(step.command);
      out.push(step);
    }
  }
  return out;
}

// --- reading the spec, within bounds -------------------------------------------------------------

/** What the capped fetch throws, which the SDK reports as a failure with this code. */
const TOO_LARGE = "HAAU3_SPEC_TOO_LARGE";

/**
 * The fetch the spec is read with: the one given, refusing an answer that says it is larger than an
 * API's spec, and stopping reading once one is. The bytes counted are the ones the body decodes to,
 * so a small compressed answer that unpacks to a large one is stopped too.
 */
export function cappedFetch(inner: typeof globalThis.fetch | undefined, max = MAX_SPEC_BYTES): typeof globalThis.fetch {
  const tooLarge = () => Object.assign(new Error("The answer is larger than an API's spec."), { code: TOO_LARGE });
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const res = await (inner ?? globalThis.fetch)(input, init);
    const length = Number(res.headers.get("content-length"));
    if (Number.isFinite(length) && length > max) {
      await res.body?.cancel().catch(() => undefined);
      throw tooLarge();
    }
    if (!res.body) return res;
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let read = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      read += value.byteLength;
      if (read > max) {
        await reader.cancel().catch(() => undefined);
        throw tooLarge();
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(read);
    let at = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, at);
      at += chunk.byteLength;
    }
    const headers = new Headers(res.headers);
    headers.delete("content-encoding");
    headers.delete("content-length");
    return new Response(bytes, { status: res.status, statusText: res.statusText, headers });
  }) as typeof globalThis.fetch;
}

/**
 * The spec's operations, with any name that holds a key's marker, or any of the key sent, taken out:
 * a host that repeats what it was sent could otherwise get the key printed. Such an operation is
 * neither named nor sent.
 */
function screened(services: Service[], key: string | null): Service[] {
  const clean = (text: string | null) => text === null || !showsKey(text, key);
  return services
    .filter((s) => clean(s.name))
    .map((s) => ({
      ...s,
      operations: s.operations.map((o): Operation => {
        const named = clean(o.operationId) && (o.kind === "unbuildable" ? clean(o.why) : clean(o.path) && o.expects.every(clean) && (o.requires ?? []).every(clean));
        return named ? o : { kind: "unbuildable", service: s.name, operationId: null, why: "its names hold what looks like an API key, so haau3 neither prints nor sends it" };
      }),
    }));
}

// --- what came back ------------------------------------------------------------------------------

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const count = (value: unknown): number | null => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null);

/** A batch's answer: how many of its entries were answered, and whether any was over a limit. */
export interface BatchCount {
  answered: number;
  total: number;
  limited: boolean;
  /** Each entry's status, as three digits, in order: never more of it. */
  statuses: string[];
}

/**
 * One count from an answer, and whether it holds nothing: a search's matches, a Bundle's entries, a
 * Parameters' parameters, an expansion's codes, or the items of an answer that is not FHIR. The
 * answer is read for these numbers only, and nothing of it is kept.
 */
export function countOf(data: unknown): { count: Count | null; resourceType: string | null; empty: boolean; batch: BatchCount | null } {
  const none = { count: null, resourceType: null, empty: false, batch: null };
  if (!isObject(data)) return none;
  const type = typeof data.resourceType === "string" && PLAIN_TYPE.test(data.resourceType) ? data.resourceType : null;
  if (type === "Bundle") {
    const entries = Array.isArray(data.entry) ? data.entry : [];
    if (data.type === "searchset") {
      // A Medical Benefits search can carry an OperationOutcome entry beside its matches, which is not one.
      const matches = entries.filter((e) => !isObject(e) || !isObject(e.search) || e.search.mode === undefined || e.search.mode === "match").length;
      // _summary=count answers a total and no entries.
      const n = entries.length === 0 ? (count(data.total) ?? 0) : matches;
      return { count: { what: "matches", n }, resourceType: type, empty: n === 0, batch: null };
    }
    if (data.type === "batch-response") {
      const statuses = entries.map((e) => {
        const status = isObject(e) && isObject(e.response) && typeof e.response.status === "string" ? e.response.status : "";
        return /^\d{3}/.test(status) ? status.slice(0, 3) : "???";
      });
      const answered = statuses.filter((s) => s.startsWith("2")).length;
      return { count: { what: "entries", n: entries.length }, resourceType: type, empty: false, batch: { answered, total: entries.length, limited: statuses.includes("429"), statuses } };
    }
    return { count: { what: "entries", n: entries.length }, resourceType: type, empty: false, batch: null };
  }
  if (type === "Parameters") return { count: { what: "parameters", n: Array.isArray(data.parameter) ? data.parameter.length : 0 }, resourceType: type, empty: false, batch: null };
  if (type === "ValueSet" && isObject(data.expansion)) {
    const contains = Array.isArray(data.expansion.contains) ? data.expansion.contains.length : 0;
    const n = Math.max(count(data.expansion.total) ?? 0, contains);
    return { count: { what: "codes", n }, resourceType: type, empty: n === 0, batch: null };
  }
  if (type !== null) return { ...none, resourceType: type };
  if (typeof data.resourceType === "string") return none;
  // An answer that is not FHIR, as Scheduling's: its one list, and its total when it has one.
  const list = Object.values(data).find(Array.isArray);
  if (!list) return none;
  const n = Math.max(list.length, count(data.total) ?? 0);
  return { count: { what: "items", n: list.length }, resourceType: null, empty: n === 0, batch: null };
}

const NOUNS: Readonly<Record<Count["what"], [string, string]>> = {
  matches: ["match", "matches"],
  entries: ["entry", "entries"],
  parameters: ["parameter", "parameters"],
  codes: ["code", "codes"],
  items: ["item", "items"],
};
const counted = (c: Count) => `${c.n} ${NOUNS[c.what][c.n === 1 ? 0 : 1]}`;

// --- one call ------------------------------------------------------------------------------------

interface RunContext {
  client: Haau3;
  options: TestOptions;
  keySent: boolean;
  /** The key sent, for the check that nothing printed holds it; null when none is sent. */
  key: string | null;
  /** The client calls an environment's own address, not a stand-in's or a proxy's. */
  own: boolean;
  /** A call with no key to the Sandbox's own address, which counts toward its hourly allowance. */
  sandboxNoKey: boolean;
  settings: Settings;
}

type Named = Pick<ExampleRequest, "service" | "operationId" | "method" | "path">;

function report(request: Named, status: CallStatus, answer: Answer | null, message: string, next: NextStep[], details: Record<string, unknown>): CallReport {
  return { service: request.service, operation: request.operationId, method: request.method, path: request.path, status, answer, message, next, details };
}

function withRequestId(message: string, problem: Problem | undefined): string {
  return problem?.requestId ? `${message} Request id: ${problem.requestId}.` : message;
}

async function call(run: RunContext, request: ExampleRequest): Promise<CallReport> {
  const { client } = run;
  const host = shownBase(client.baseURL);
  const options = { pathParams: request.pathParams, query: request.query, expects: request.expects, timeout: CALL_TIMEOUT_MS, maxRetries: 0 };
  try {
    const promise = request.method === "GET" ? client.get(request.path, options) : client.post(request.path, { ...options, body: request.body });
    const { data, status, durationMs, requestId } = await promise.withResponse();
    const { count: found, resourceType, empty, batch } = countOf(data);
    // A FHIR answer's type is printed only when it is one the spec documents.
    const type = resourceType !== null && request.expects.includes(resourceType) && !showsKey(resourceType, run.key) ? resourceType : null;
    const details: Record<string, unknown> = { status, durationMs, requestId: safeRequestId(requestId), count: found, resourceType: type };
    if (request.requires !== null && (!isObject(data) || request.requires.some((name) => !Object.hasOwn(data, name)))) {
      return report(request, "fail", "unreadable", `${host} answered ${status} with something other than the answer its spec describes, so it may not be the haau3 API.`, [], details);
    }
    if (batch) {
      details.batch = batch;
      if (batch.limited) {
        return report(request, "warn", "over-a-limit", `Answered ${status}, but an entry was over a limit (429), so the run stops here.`, [rerunStep(run.options, request.service)], details);
      }
      if (batch.answered < batch.total || batch.total === 0) {
        return report(
          request,
          "fail",
          "refused",
          `Answered ${status}, but ${batch.total - batch.answered} of ${batch.total} entries were not answered (${batch.statuses.join(", ")}). The batch is the spec's own example.`,
          [REPORT_STEP],
          details,
        );
      }
    }
    if (empty) {
      return report(request, "warn", "answered-empty", `Answered ${status} in ${durationMs} ms, with nothing in it: the example matched nothing. The call works, but proved less.`, [], details);
    }
    const what = found ? `: ${counted(found)}` : type ? `: a ${type}` : "";
    return report(request, "pass", "answered", `Answered ${status} in ${durationMs} ms${what}.`, [], details);
  } catch (error) {
    return refused(run, request, sortError(error, run.key), host);
  }
}

function refused(run: RunContext, request: ExampleRequest, sorted: Sorted, host: string): CallReport {
  const { problem } = sorted;
  const status = problem?.status;
  const code = problem?.code;
  const details: Record<string, unknown> = { status: status ?? null, requestId: problem?.requestId ?? null, problem: problem ?? null };
  if (sorted.reason !== undefined) Object.assign(details, { reason: sorted.reason, detail: sorted.detail ?? null });
  const rerun = rerunStep(run.options, request.service);
  const fail = (message: string, next: NextStep[] = []) => report(request, "fail", sorted.answer, withRequestId(message, problem), next, details);
  const file = run.settings.key?.path ? run.settings.key.source : run.options.file;
  switch (sorted.answer) {
    case "not-open-to-customers":
      // An expected answer in production only: the Sandbox answers this operation for its test members.
      if (run.own && run.client.environment === "production") {
        return report(
          request,
          "pass",
          "not-open-to-customers",
          `Not open to customers yet (403 not-open-to-customers), as documented. The Sandbox answers it for its test members.`,
          [keysCreateStep({ test: true }, "Make a free test key: calls with it go to the Sandbox.")],
          details,
        );
      }
      return fail(`Refused (403 not-open-to-customers) where this operation should answer. Report it.`, [REPORT_STEP]);
    case "bad-key":
      if (!run.keySent) return fail(`${host} refused a call with no key (401).`, [LOGIN_STEP, KEYS_CREATE_STEP]);
      return fail("The API did not take the key (401): it is not one the API knows, or it was revoked. The run stops here.", [
        keysCreateStep({ test: run.client.environment === "sandbox", replace: true, file }, "Make a new key in place of it."),
      ]);
    case "wrong-key-mode":
      return fail(`The API took the key but refused it here (403${code ? ` ${code}` : ""}): this key's mode does not work at this address. The run stops here.`);
    case "needs-an-agreement":
      return fail(
        "Refused (403 phi-agreement-required): the organization has no agreement for patient data, and the API did not take the example as test data marked as such. The example is the spec's own, so report it.",
        [REPORT_STEP],
      );
    case "not-the-example":
      return fail("The Sandbox did not take the spec's own example (400 not-the-example), so the spec and the Sandbox disagree. Report it.", [REPORT_STEP]);
    case "refused":
      return fail(`Refused (${status ?? "no status"}${code ? ` ${code}` : ""}). The request is the spec's own example, so this may be a fault in the spec or the API.`);
    case "over-a-limit": {
      const later = sorted.retryAfter !== undefined ? ` It says to try again in ${sorted.retryAfter} s.` : "";
      Object.assign(details, { retryAfter: sorted.retryAfter ?? null });
      if (run.sandboxNoKey) {
        return report(
          request,
          "warn",
          "over-a-limit",
          withRequestId(`Over the Sandbox's allowance for calls with no key from this address (429).${later} A free test key raises it.`, problem),
          [keysCreateStep({ test: true }, "Make a free test key, which raises the limit.")],
          details,
        );
      }
      return report(request, "warn", "over-a-limit", withRequestId(`Over a limit (429).${later}`, problem), [rerun], details);
    }
    case "unreachable":
      return fail(`Could not reach ${host}${sorted.detail ? ` (${sorted.detail})` : ""}. Check the network, a proxy or a firewall. The run stops here.`, [rerun]);
    case "no-answer":
      return fail(`No answer (${sorted.reason}${status ? `, ${status}` : ""}). ${COLD_START}`, [rerun]);
    case "unreadable":
      return fail(`${host} answered with something that is not ${request.expects.length ? `a ${request.expects.join(" or ")}` : "JSON"}, so it may not be the haau3 API.`);
    case "not-sent":
      return fail("haau3 did not send it: the SDK refused the request built from the spec's example.", [REPORT_STEP]);
    default:
      return fail(`haau3 could not call it (${sorted.name ?? "an error"}).`);
  }
}

/** Why a call stops the run, or null: a 429, a key the API refused, or no answer at all. */
function stopsRun(result: CallReport): string | null {
  if (result.answer === "over-a-limit") return "the API said to slow down";
  if (result.answer === "bad-key" || result.answer === "wrong-key-mode") return "the API refused the key";
  if (result.answer === "unreachable") return "the API could not be reached";
  if (result.answer === "no-answer" && result.details.reason === "timeout") return "the API did not answer in time";
  return null;
}

/** How many requests a call counts as: a batch's entries when answered, one for any other answer, none for a 429 or no answer. */
function requestsMade(result: CallReport, request: ExampleRequest): number {
  const status = result.details.status;
  if (typeof status !== "number" || status === 429) return 0;
  return status >= 200 && status < 300 ? request.requests : 1;
}

// --- the run -------------------------------------------------------------------------------------

/** Where the calls went, for a person. */
function header(run: RunContext, version: string | null): string {
  const env = run.client.environment;
  const where = run.own ? `${NAMED[env]} at ${shownBase(run.client.baseURL)}` : shownBase(run.client.baseURL);
  return `Called ${where} ${run.keySent ? "with the key" : "with no key"}, from its spec${version ? ` ${version}` : ""}.`;
}

/** Where the requests count, for a person. */
function counts(run: RunContext): string {
  if (!run.own) return "";
  if (run.client.environment === "production") return " Each counts toward the organization's monthly requests, as any request does.";
  if (run.keySent) return " Calls to the Sandbox with a test key count toward no month.";
  return " Calls with no key count toward the Sandbox's hourly allowance for this address.";
}

const STATUS_WIDTH = 4;

function lines(calls: CallReport[]): string[] {
  let service = 7;
  let operation = 13;
  for (const c of calls) {
    service = Math.max(service, c.service.length);
    operation = Math.max(operation, (c.operation ?? "(not printed)").length);
  }
  return calls.map((c) => `  ${c.status.padEnd(STATUS_WIDTH)}  ${c.service.padEnd(service)}  ${(c.operation ?? "(not printed)").padEnd(operation)}  ${c.message}`);
}

function unbuildableReport(service: string, operationId: string | null, why: string): CallReport {
  return {
    service,
    operation: operationId,
    method: null,
    path: null,
    status: "fail",
    answer: "not-sent",
    message: `haau3 did not send it: ${why}, so its example request cannot be built from the spec.`,
    next: [REPORT_STEP],
    details: { why },
  };
}

/** A failure before any call: nothing was sent but, perhaps, the spec's read. */
function stopped(code: string, message: string, next: NextStep[], environment: Environment | null = null): Result {
  return { document: failure(COMMAND, { code, message, next }, environment), text: "", exit: EXIT.failed };
}

/** Why the spec could not be read, in words: never what the host sent. */
function specWhy(sorted: Sorted, host: string): string {
  if (sorted.detail === TOO_LARGE) return `${host} answered with more than an API's spec holds`;
  switch (sorted.answer) {
    case "unreachable":
      return `could not reach ${host}${sorted.detail ? ` (${sorted.detail})` : ""}`;
    case "over-a-limit":
      return `${host} is over a limit for now (429)${sorted.retryAfter !== undefined ? `, and says to try again in ${sorted.retryAfter} s` : ""}`;
    case "unreadable":
      return `${host} answered /openapi.json with something that is not JSON, so it may not be the haau3 API`;
    case "no-answer":
      return `no answer from ${host} (${sorted.reason}). ${COLD_START}`;
    default:
      return `${host} refused it (${sorted.problem?.status ?? sorted.name ?? "an error"})`;
  }
}

export async function test(ctx: Context, options: TestOptions): Promise<Result> {
  if (options.file !== undefined) {
    const refused = fileFlagError(options.file, { command: "npx haau3 test", description: "Read the project's own env files instead." });
    if (refused) return misused(COMMAND, refused);
  }
  if (options.service !== undefined && !TYPED_SERVICE.test(options.service)) {
    // Never repeated: it may be anything, a key included.
    return misused(COMMAND, { code: "unknown-service", message: "haau3 test has no such service.", next: [{ command: "npx haau3 test", description: "Run one call for every service." }] });
  }
  const settings = findSettings({ cwd: ctx.cwd, env: ctx.env, file: options.file });
  const doctor = doctorStep(options.file);

  // A file named with --file that could not be read leaves nothing to test: say so, rather than run with no key.
  const named = options.file === undefined ? undefined : settings.files[0];
  if (named && named.state !== "read") {
    const why = named.state === "missing" ? "does not exist" : "could not be read as an env file";
    return stopped("file-not-read", `--file names ${named.shown}, which ${why}. Nothing was sent.`, [{ command: "npx haau3 test", description: "Read the project's own env files instead." }]);
  }

  if (settings.key && !keyFacts(settings.key).sendable) {
    return stopped(
      "key-not-sent",
      `${KEY_VARIABLE} ${where(settings.key)} is not a haau3 key haau3 will send: it does not start with haau3_sk_, or it holds a character that is not visible text. Nothing was sent.`,
      [doctor],
    );
  }

  // Where the calls go, and with which key: doctor's rules (src/client.ts). The spec is read with the
  // same client, through a fetch that stops reading at an API spec's size.
  const made = makeClient(ctx, settings);
  if (!made.ok && made.why === "address") return stopped("bad-settings", `${made.message} Nothing was sent.`, [doctor]);
  if (!made.ok && made.why === "refused") return stopped("bad-settings", `${made.message} Nothing was sent.`, [...made.next, doctor]);

  let keyed: boolean;
  let setupWhy: "no-key" | "key-kept" | null = null;
  if (!made.ok) {
    // No key, and the Sandbox not named: production takes no call without a key; anything else runs
    // in the Sandbox with no key, as the app as set up could not (owner, 2026-11-12).
    const namesProduction =
      namedEnvironment(settings) === "production" || (made.baseURL !== undefined && new URL(made.baseURL).origin === ENVIRONMENT_ADDRESSES.production);
    if (namesProduction) {
      return stopped(
        "no-key",
        `No API key, and ${settings.environment ? `${ENVIRONMENT_VARIABLE} ${where(settings.environment)}` : BASE_URL_VARIABLE} names production, which takes no call without a key. Nothing was sent.`,
        [LOGIN_STEP, KEYS_CREATE_STEP, sandboxStep(process.platform)],
        "production",
      );
    }
    keyed = false;
    setupWhy = "no-key";
  } else if (settings.key && !keyMayGo(made.client)) {
    // A base URL that is neither haau3's nor this computer gets no key (owner, 2026-11-12).
    keyed = false;
    setupWhy = "key-kept";
  } else {
    keyed = true;
  }
  const baseURL = made.ok || made.why === "no-key" ? made.baseURL : undefined;
  const clientWith = (fetch: typeof globalThis.fetch | undefined): Haau3 | null => {
    if (!keyed) return keylessClient({ fetch }, baseURL);
    const again: ClientMade = makeClient({ fetch }, settings);
    return again.ok ? again.client : null;
  };
  const runClient = clientWith(ctx.fetch);
  const specClient = clientWith(cappedFetch(ctx.fetch));
  if (!runClient || !specClient) return stopped("bad-settings", "haau3 could not make a client for these settings. Nothing was sent.", [doctor]);

  const own = runClient.baseURL === ENVIRONMENT_ADDRESSES[runClient.environment];
  const environment: Environment | null = own ? runClient.environment : null;
  const keySent = keyed && settings.key !== null;
  const sandboxNoKey = !keySent && new URL(runClient.baseURL).origin === ENVIRONMENT_ADDRESSES.sandbox;
  const host = shownBase(runClient.baseURL);
  let setup: { status: "warn"; message: string; next: NextStep[] } | null = null;
  if (setupWhy === "no-key") {
    const ran = sandboxNoKey ? "in the Sandbox" : `at ${host}`;
    setup = {
      status: "warn",
      message: `No API key was found, so this ran ${ran} with no key. Your app, as set up, makes no client: set ${ENVIRONMENT_VARIABLE}=sandbox where it reads its settings, or sign in and make a key.`,
      next: [sandboxStep(process.platform), LOGIN_STEP, options.file === undefined ? KEYS_CREATE_STEP : keysCreateStep({ file: options.file }, KEYS_CREATE_STEP.description)],
    };
  } else if (setupWhy === "key-kept") {
    setup = {
      status: "warn",
      message: `${BASE_URL_VARIABLE} ${where(settings.baseURL!)} sends every call to ${host}, which is neither haau3's own address nor this computer, so haau3 called it with no key.`,
      next: [],
    };
  }

  // With no key, --all runs one service at a time: every operation is more than the Sandbox's hourly
  // allowance for one address (owner, 2026-11-12). Refused before anything is read.
  if (options.all && options.service === undefined && sandboxNoKey) {
    return misused(
      COMMAND,
      {
        code: "needs-a-key",
        message: "With no key, --all runs one service at a time: every operation of every service is more than the Sandbox's small hourly allowance for calls with no key. Name a service, or make a free test key, which raises it.",
        next: [
          { command: "npx haau3 test terminology --all", description: "Every operation of one service." },
          keysCreateStep({ test: true }, "Make a free test key, which raises the limit."),
        ],
      },
      environment,
    );
  }

  // The spec, from the host the calls go to. It needs no key and counts toward no allowance.
  const key = keySent ? (settings.key?.value.trim() ?? null) : null;
  let doc: unknown;
  try {
    doc = await specClient.get("/openapi.json", { timeout: CALL_TIMEOUT_MS, maxRetries: 0 });
  } catch (error) {
    return stopped("spec-unreadable", `haau3 could not read the API's spec: ${specWhy(sortError(error, key), host)}. Nothing else was sent.`.replace(/\.\. /, ". "), [rerunStep(options, null)], environment);
  }
  const spec = readSpec(doc);
  if (!spec.ok) {
    return stopped("spec-unreadable", `${host} answered /openapi.json, but ${spec.why}, so it may not be the haau3 API. Nothing else was sent.`, [doctor], environment);
  }
  const version = spec.version !== null && !showsKey(spec.version, key) ? spec.version : null;
  const listed = screened(spec.services, key);
  if (listed.length === 0) return stopped("spec-unreadable", `${host} answered /openapi.json, but it lists no operation haau3 can call. Nothing else was sent.`, [doctor], environment);

  // Which services, and which of their operations.
  let services: Service[] = listed;
  if (options.service !== undefined) {
    const wanted = serviceName(options.service);
    const found = listed.find((s) => s.name === wanted);
    if (!found) {
      if (wanted === "sandbox") {
        return misused(
          COMMAND,
          {
            code: "sandbox-is-an-environment",
            message: `The Sandbox is an environment, not a service: a test key, or ${ENVIRONMENT_VARIABLE}=sandbox, sends every call there.`,
            next: [sandboxStep(process.platform), { command: "npx haau3 test", description: "Then run one call for every service there." }],
          },
          environment,
        );
      }
      // What was typed is never repeated: it may be part of a key. The spec's own names are plain.
      return misused(
        COMMAND,
        {
          code: "unknown-service",
          message: `haau3 test has no such service. The spec lists ${listed.map((s) => s.name).join(", ")}.`,
          next: listed.slice(0, 3).map((s) => ({ command: `npx haau3 test ${s.name}`, description: `One call to ${s.name}.` })),
        },
        environment,
      );
    }
    services = [found];
  }
  const planned: Operation[] = [];
  for (const s of services) for (const o of options.all ? s.operations : s.operations.slice(0, 1)) planned.push(o);

  const run: RunContext = { client: runClient, options, keySent, key, own, sandboxNoKey, settings };
  const calls: CallReport[] = [];
  let requests = 0;
  let stoppedBy: { why: string; operation: string | null } | null = null;
  for (const operation of planned) {
    if (operation.kind === "unbuildable") {
      calls.push(unbuildableReport(operation.service, operation.operationId, operation.why));
      continue;
    }
    if (stoppedBy) {
      calls.push(report(operation, "skip", null, `Not run: ${stoppedBy.why}.`, [], { waitsOn: stoppedBy.operation }));
      continue;
    }
    const result = await call(run, operation);
    requests += requestsMade(result, operation);
    calls.push(result);
    const why = stopsRun(result);
    if (why) stoppedBy = { why, operation: result.operation };
  }

  // The report.
  const failed = calls.filter((c) => c.status === "fail");
  const warned = calls.filter((c) => c.status === "warn");
  const skipped = calls.filter((c) => c.status === "skip");
  const passed = calls.filter((c) => c.status === "pass").length;
  const answered = calls.some((c) => c.answer === "answered" || c.answer === "answered-empty" || (c.answer === "not-open-to-customers" && c.status === "pass"));
  const data = {
    environment,
    baseURL: host,
    specVersion: version,
    keySent,
    service: options.service === undefined ? null : services[0]!.name,
    all: options.all,
    setup,
    calls,
    requests,
    skippedOperations: spec.skipped,
    next: steps([...failed.map((c) => c.next), ...(setup ? [setup.next] : []), ...warned.map((c) => c.next)]),
  };
  const text = [header(run, version)];
  if (setup) text.push(setup.message);
  text.push("", ...lines(calls), "");
  const parts = [`${passed} answered as documented`];
  if (warned.length) parts.push(`${warned.length} with a warning`);
  if (failed.length) parts.push(`${failed.length} failed`);
  if (skipped.length) parts.push(`${skipped.length} not run`);
  text.push(`${calls.length} call${calls.length === 1 ? "" : "s"}: ${parts.join(", ")}. Made ${requests} request${requests === 1 ? "" : "s"}.${requests ? counts(run) : ""}`);
  text.push("A call answered is a call answered: it does not say a service is licensed, under an agreement or ready for production.");

  if (failed.length === 0 && answered) {
    const next = steps([...(setup ? [setup.next] : []), ...warned.map((c) => c.next)]);
    if (next.length) text.push("", "Next:", ...next.map((step) => `  ${step.command}\n    ${step.description}`));
    return { document: success(COMMAND, data, environment), text: `${text.join("\n")}\n`, exit: EXIT.ok };
  }
  const failedNext = steps(failed.map((c) => c.next));
  const failedCommands = new Set(failedNext.map((step) => step.command));
  const alsoNext = steps([...(setup ? [setup.next] : []), ...warned.map((c) => c.next)]).filter((step) => !failedCommands.has(step.command));
  if (alsoNext.length) text.push("", "For the warnings:", ...alsoNext.map((step) => `  ${step.command}\n    ${step.description}`));
  // A run with no failure and nothing answered proved nothing, so it does not pass (owner, 2026-11-12).
  const error =
    failed.length === 0
      ? { code: "nothing-answered", message: "No call was answered, so nothing was proved.", next: steps(warned.map((c) => c.next)) }
      : { code: "calls-failed", message: `${failed.length} call${failed.length === 1 ? "" : "s"} failed (${failed.map((c) => c.operation ?? "(not printed)").join(", ")}).`, next: failedNext };
  return { document: failure(COMMAND, error, environment, data), text: `${text.join("\n")}\n`, exit: EXIT.failed };
}
