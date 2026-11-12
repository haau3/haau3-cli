// `haau3 test [service]`: one safe call per service, built from the published spec's own examples,
// and what kind of answer came back. It reads the spec from the host the calls go to, sends each
// operation's documented example and nothing else, and reports only the status, the request id, the
// timing and a count: never a body, an example's value, or the answer's words.
//
// Where calls go is doctor's: the settings where the application finds them, and the SDK picks the
// host. With no key and nothing named it runs in the Sandbox with no key, and says the app as set up
// makes no client. A key goes only to haau3's own two addresses or to this computer.
import type { Haau3 } from "@haau3/sdk";
import { CALL_TIMEOUT_MS, COLD_START, keyFacts, keyMayGo, NAMED, safeRequestId, shownBase, sortError, type Sorted } from "../calls.js";
import { keylessClient, makeClient, namedEnvironment } from "../client.js";
import { fileFlagError } from "../envfile.js";
import { ENVIRONMENT_ADDRESSES } from "../environment.js";
import { failure, success, EXIT, type NextStep, type Problem } from "../output.js";
import { BASE_URL_VARIABLE, ENVIRONMENT_VARIABLE, findSettings, KEY_VARIABLE, where, type Settings } from "../settings.js";
import { MAX_SPEC_CHARS, readSpec, serviceName, type ExampleRequest, type Service, type Unbuildable } from "../spec.js";
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

/** A name a person typed for a service, as it may be repeated back. */
const TYPED_SERVICE = /^[A-Za-z][A-Za-z0-9 _-]{0,40}$/;
const PLAIN_NAME = /^[a-z][a-z0-9-]{0,40}$/;
const PLAIN_TYPE = /^[A-Z][A-Za-z]{0,63}$/;

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
  return lists.flat().filter((step) => (seen.has(step.command) ? false : (seen.add(step.command), true)));
}

// --- what came back ------------------------------------------------------------------------------

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * One count from an answer, and whether it holds nothing: a search's matches, a Bundle's entries, a
 * Parameters' parameters, an expansion's codes, or the items of an answer that is not FHIR. The
 * answer is read for these numbers only, and nothing of it is kept.
 */
export function countOf(data: unknown): { count: Count | null; resourceType: string | null; empty: boolean } {
  if (!isObject(data)) return { count: null, resourceType: null, empty: false };
  const type = typeof data.resourceType === "string" && PLAIN_TYPE.test(data.resourceType) ? data.resourceType : null;
  if (type === "Bundle") {
    const entries = Array.isArray(data.entry) ? data.entry : [];
    if (data.type === "searchset") {
      // A Medical Benefits search can carry an OperationOutcome entry beside its matches, which is not one.
      const matches = entries.filter((e) => !isObject(e) || !isObject(e.search) || e.search.mode === undefined || e.search.mode === "match").length;
      const total = typeof data.total === "number" ? data.total : null;
      return { count: { what: "matches", n: matches }, resourceType: type, empty: matches === 0 && !(total !== null && total > 0) };
    }
    return { count: { what: "entries", n: entries.length }, resourceType: type, empty: false };
  }
  if (type === "Parameters") return { count: { what: "parameters", n: Array.isArray(data.parameter) ? data.parameter.length : 0 }, resourceType: type, empty: false };
  if (type === "ValueSet" && isObject(data.expansion)) {
    const { total, contains } = data.expansion;
    const n = typeof total === "number" ? total : Array.isArray(contains) ? contains.length : 0;
    return { count: { what: "codes", n }, resourceType: type, empty: n === 0 };
  }
  if (type !== null) return { count: null, resourceType: type, empty: false };
  if (typeof data.resourceType === "string") return { count: null, resourceType: null, empty: false };
  // An answer that is not FHIR, as Scheduling's: its one list, and its total when it has one.
  const list = Object.values(data).find(Array.isArray);
  if (!list) return { count: null, resourceType: null, empty: false };
  const total = typeof data.total === "number" ? data.total : null;
  return { count: { what: "items", n: list.length }, resourceType: null, empty: list.length === 0 && !(total !== null && total > 0) };
}

const NOUNS: Readonly<Record<Count["what"], [string, string]>> = {
  matches: ["match", "matches"],
  entries: ["entry", "entries"],
  parameters: ["parameter", "parameters"],
  codes: ["code", "codes"],
  items: ["item", "items"],
};
const counted = (count: Count) => `${count.n} ${NOUNS[count.what][count.n === 1 ? 0 : 1]}`;

// --- one call ------------------------------------------------------------------------------------

interface RunContext {
  client: Haau3;
  options: TestOptions;
  keySent: boolean;
  /** A call with no key to the Sandbox's own address, which counts toward its hourly allowance. */
  sandboxNoKey: boolean;
  settings: Settings;
}

function report(request: Pick<ExampleRequest, "service" | "operationId" | "method" | "path">, status: CallStatus, answer: Answer | null, message: string, next: NextStep[], details: Record<string, unknown>): CallReport {
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
    const { count, resourceType, empty } = countOf(data);
    const details = { status, durationMs, requestId: safeRequestId(requestId), count, resourceType };
    if (empty) {
      return report(request, "warn", "answered-empty", `Answered ${status} in ${durationMs} ms, with nothing in it: the example matched nothing. The call works, but proved less.`, [], details);
    }
    const what = count ? `: ${counted(count)}` : resourceType ? `: a ${resourceType}` : "";
    return report(request, "pass", "answered", `Answered ${status} in ${durationMs} ms${what}.`, [], details);
  } catch (error) {
    const sorted = sortError(error, run.keySent ? (run.settings.key?.value.trim() ?? null) : null);
    return refused(run, request, sorted, host);
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
      return report(
        request,
        "pass",
        "not-open-to-customers",
        `Not open to customers yet (403 not-open-to-customers), as documented. The Sandbox answers it for its test members.`,
        [keysCreateStep({ test: true }, "Make a free test key: calls with it go to the Sandbox.")],
        details,
      );
    case "bad-key":
      if (!run.keySent) return fail(`${host} refused a call with no key (401).`, [LOGIN_STEP, KEYS_CREATE_STEP]);
      return fail("The API did not take the key (401): it is not one the API knows, or it was revoked.", [
        keysCreateStep({ test: run.client.environment === "sandbox", replace: true, file }, "Make a new key in place of it."),
      ]);
    case "wrong-key-mode":
      return fail(`The API took the key but refused it here (403${code ? ` ${code}` : ""}): this key's mode does not work at this address.`);
    case "needs-an-agreement":
      return fail(
        "Refused (403 phi-agreement-required): the organization has no agreement for patient data, and the API did not take the example as test data marked as such. The example is the spec's own, so report it.",
        [{ command: "npx haau3@latest --version", description: "Check for a newer version, then report it at https://github.com/haau3/haau3-cli/issues." }],
      );
    case "not-the-example":
      return fail("The Sandbox did not take the spec's own example (400 not-the-example), so the spec and the Sandbox disagree. Report it.", [
        { command: "npx haau3@latest --version", description: "Check for a newer version, then report it at https://github.com/haau3/haau3-cli/issues." },
      ]);
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
      return fail(`Could not reach ${host}${sorted.detail ? ` (${sorted.detail})` : ""}. Check the network, a proxy or a firewall.`, [rerun]);
    case "no-answer":
      return fail(`No answer (${sorted.reason}${status ? `, ${status}` : ""}). ${COLD_START}`, [rerun]);
    case "unreadable":
      return fail(`${host} answered with something that is not ${request.expects.length ? `a ${request.expects.join(" or ")}` : "JSON"}, so it may not be the haau3 API.`);
    case "not-sent":
      return fail("haau3 did not send it: the SDK refused the request built from the spec's example.");
    default:
      return fail(`haau3 could not call it (${sorted.name ?? "an error"}).`);
  }
}

// --- the run -------------------------------------------------------------------------------------

/** Where the calls went, for a person. */
function header(run: RunContext, version: string | null): string {
  const env = run.client.environment;
  const own = run.client.baseURL === ENVIRONMENT_ADDRESSES[env];
  const where = own ? `${NAMED[env]} at ${shownBase(run.client.baseURL)}` : shownBase(run.client.baseURL);
  return `Called ${where} ${run.keySent ? "with the key" : "with no key"}, from its spec${version ? ` ${version}` : ""}.`;
}

/** Where the requests count, for a person. */
function counts(run: RunContext): string {
  const env = run.client.environment;
  if (run.client.baseURL !== ENVIRONMENT_ADDRESSES[env]) return "";
  if (env === "production") return " Each counts toward the organization's monthly requests, as any request does.";
  if (run.keySent) return " Calls to the Sandbox with a test key count toward no month.";
  return " Calls with no key count toward the Sandbox's hourly allowance for this address.";
}

const STATUS_WIDTH = 4;

function lines(calls: CallReport[]): string[] {
  const service = Math.max(...calls.map((c) => c.service.length), 7);
  const operation = Math.max(...calls.map((c) => (c.operation ?? "(not printed)").length), 9);
  return calls.map((c) => `  ${c.status.padEnd(STATUS_WIDTH)}  ${c.service.padEnd(service)}  ${(c.operation ?? "(not printed)").padEnd(operation)}  ${c.message}`);
}

function unbuildableReport(u: Unbuildable): CallReport {
  return {
    service: u.service,
    operation: u.operationId,
    method: null,
    path: null,
    status: "fail",
    answer: "not-sent",
    message: `haau3 did not send it: ${u.why}, so its example request cannot be built from the spec.`,
    next: [{ command: "npx haau3@latest --version", description: "Check for a newer version, then report it at https://github.com/haau3/haau3-cli/issues." }],
    details: { why: u.why },
  };
}

/** A failure before any call: nothing was sent but, perhaps, the spec's read. */
function stopped(code: string, message: string, next: NextStep[], environment: "production" | "sandbox" | null = null): Result {
  return { document: failure(COMMAND, { code, message, next }, environment), text: "", exit: EXIT.failed };
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

  if (settings.key && !keyFacts(settings.key).sendable) {
    return stopped(
      "key-not-sent",
      `${KEY_VARIABLE} ${where(settings.key)} is not a haau3 key haau3 will send: it does not start with haau3_sk_, or it holds a character that is not visible text. Nothing was sent.`,
      [doctor],
    );
  }

  // Where the calls go, and with which key: doctor's rules (src/client.ts).
  const made = makeClient(ctx, settings);
  if (!made.ok && made.why === "address") return stopped("bad-settings", `${made.message} Nothing was sent.`, [doctor]);
  if (!made.ok && made.why === "refused") return stopped("bad-settings", `${made.message} Nothing was sent.`, [...made.next, doctor]);

  let runClient: Haau3;
  let keySent = false;
  let setup: { status: "warn"; message: string; next: NextStep[] } | null = null;
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
    const keyless = keylessClient(ctx, made.baseURL);
    if (!keyless) return stopped("bad-settings", "haau3 could not make a client with no key for the Sandbox. Nothing was sent.", [doctor]);
    runClient = keyless;
    setup = {
      status: "warn",
      message: `No API key was found, so this ran in the Sandbox with no key. Your app, as set up, makes no client: sign in and make a key, or set ${ENVIRONMENT_VARIABLE}=sandbox where it reads its settings.`,
      next: [LOGIN_STEP, options.file === undefined ? KEYS_CREATE_STEP : keysCreateStep({ file: options.file }, KEYS_CREATE_STEP.description), sandboxStep(process.platform)],
    };
  } else if (settings.key && !keyMayGo(made.client)) {
    // A base URL that is neither haau3's nor this computer gets no key (owner, 2026-11-12).
    const keyless = keylessClient(ctx, made.baseURL);
    if (!keyless) return stopped("bad-settings", "haau3 could not make a client with no key for that address. Nothing was sent.", [doctor]);
    runClient = keyless;
    setup = {
      status: "warn",
      message: `${BASE_URL_VARIABLE} ${where(settings.baseURL!)} sends every call to ${shownBase(made.client.baseURL)}, which is neither haau3's own address nor this computer, so haau3 called it with no key.`,
      next: [],
    };
  } else {
    runClient = made.client;
    keySent = settings.key !== null;
  }
  const sandboxNoKey = !keySent && runClient.baseURL === ENVIRONMENT_ADDRESSES.sandbox;

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
      runClient.environment,
    );
  }

  // The spec, from the host the calls go to. It needs no key and counts toward no allowance.
  const host = shownBase(runClient.baseURL);
  let doc: unknown;
  try {
    doc = await runClient.get("/openapi.json", { timeout: CALL_TIMEOUT_MS, maxRetries: 0 });
  } catch (error) {
    const sorted = sortError(error, null);
    const why =
      sorted.answer === "unreachable"
        ? `could not reach ${host}${sorted.detail ? ` (${sorted.detail})` : ""}`
        : sorted.reason !== undefined
          ? `no answer from ${host} (${sorted.reason}). ${COLD_START}`
          : `${host} refused it (${sorted.problem?.status ?? sorted.name ?? "an error"})`;
    return stopped("spec-unreadable", `haau3 could not read the API's spec: ${why}`.replace(/\.?$/, ".") + " Nothing else was sent.", [rerunStep(options, null)], runClient.environment);
  }
  const size = JSON.stringify(doc ?? null).length;
  const spec = size <= MAX_SPEC_CHARS ? readSpec(doc) : ({ ok: false, why: "it is larger than an API's spec" } as const);
  if (!spec.ok) {
    return stopped("spec-unreadable", `${host} answered /openapi.json, but ${spec.why}, so it may not be the haau3 API. Nothing else was sent.`, [doctor], runClient.environment);
  }

  // Which services, and which of their operations.
  let services: Service[] = spec.services;
  if (options.service !== undefined) {
    const wanted = serviceName(options.service);
    const found = spec.services.find((s) => s.name === wanted);
    if (!found) {
      if (wanted === "sandbox") {
        return misused(
          COMMAND,
          {
            code: "sandbox-is-an-environment",
            message: `The Sandbox is an environment, not a service: a test key, or ${ENVIRONMENT_VARIABLE}=sandbox, sends every call there.`,
            next: [sandboxStep(process.platform), { command: "npx haau3 test", description: "Then run one call for every service there." }],
          },
          runClient.environment,
        );
      }
      const named = PLAIN_NAME.test(wanted) ? `haau3 test has no service named ${wanted}.` : "haau3 test has no such service.";
      return misused(
        COMMAND,
        { code: "unknown-service", message: `${named} The spec lists ${spec.services.map((s) => s.name).join(", ")}.`, next: spec.services.slice(0, 3).map((s) => ({ command: `npx haau3 test ${s.name}`, description: `One call to ${s.name}.` })) },
        runClient.environment,
      );
    }
    services = [found];
  }
  const planned = services.flatMap((s) => (options.all ? s.operations : s.operations.slice(0, 1)));
  const unbuildable = spec.unbuildable.filter((u) => services.some((s) => s.name === u.service) && (options.all || services.find((s) => s.name === u.service)!.operations.length === 0));

  const run: RunContext = { client: runClient, options, keySent, sandboxNoKey, settings };
  const calls: CallReport[] = [];
  let requests = 0;
  let stoppedBy: CallReport | null = null;
  for (const request of planned) {
    if (stoppedBy) {
      calls.push(report(request, "skip", null, "Not run: the API said to slow down.", [], { waitsOn: stoppedBy.operation }));
      continue;
    }
    const result = await call(run, request);
    if (result.answer !== "not-sent") requests += request.requests;
    calls.push(result);
    if (result.answer === "over-a-limit") stoppedBy = result;
  }
  calls.push(...unbuildable.map(unbuildableReport));

  // The report.
  const failed = calls.filter((c) => c.status === "fail");
  const warned = calls.filter((c) => c.status === "warn");
  const environment = runClient.environment;
  const data = {
    environment,
    baseURL: shownBase(runClient.baseURL),
    specVersion: spec.version,
    keySent,
    service: options.service === undefined ? null : services[0]!.name,
    all: options.all,
    setup,
    calls,
    requests,
    next: steps([...failed.map((c) => c.next), ...(setup ? [setup.next] : []), ...warned.map((c) => c.next)]),
  };
  const text = [header(run, spec.version)];
  if (setup) text.push(setup.message);
  text.push("", ...lines(calls), "");
  const passed = calls.filter((c) => c.status === "pass").length;
  const tally = `${calls.length} call${calls.length === 1 ? "" : "s"}: ${passed} answered as documented${warned.length ? `, ${warned.length} with a warning` : ""}${failed.length ? `, ${failed.length} failed` : ""}.`;
  text.push(`${tally} Made ${requests} request${requests === 1 ? "" : "s"}.${requests ? counts(run) : ""}`);
  text.push("A call answered is a call answered: it does not say a service is licensed, under an agreement or ready for production.");

  if (failed.length === 0) {
    const next = steps([...(setup ? [setup.next] : []), ...warned.map((c) => c.next)]);
    if (next.length) text.push("", "Next:", ...next.map((step) => `  ${step.command}\n    ${step.description}`));
    return { document: success(COMMAND, data, environment), text: `${text.join("\n")}\n`, exit: EXIT.ok };
  }
  const failedNext = steps(failed.map((c) => c.next));
  const failedCommands = new Set(failedNext.map((step) => step.command));
  const alsoNext = steps([...(setup ? [setup.next] : []), ...warned.map((c) => c.next)]).filter((step) => !failedCommands.has(step.command));
  if (alsoNext.length) text.push("", "For the warnings:", ...alsoNext.map((step) => `  ${step.command}\n    ${step.description}`));
  const names = failed.map((c) => c.operation ?? "(not printed)").join(", ");
  const error = { code: "calls-failed", message: `${failed.length} call${failed.length === 1 ? "" : "s"} failed (${names}).`, next: failedNext };
  return { document: failure(COMMAND, error, environment, data), text: `${text.join("\n")}\n`, exit: EXIT.failed };
}
