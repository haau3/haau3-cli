// The published spec, read at run time from the host the calls go to, and each operation's example
// request built from it: every parameter that carries an `example`, and no other, and the body's one
// example. That is the request the docs' samples send and the Sandbox answers. Nothing here is kept
// by hand, so a new operation needs no new release of the command line.
//
// The document comes from the API's own host, or from wherever HAAU3_BASE_URL points, which can be
// anything: so it is read as untrusted data. A name from it is printed only when it is plain, an
// operation it describes in a way the command line cannot send is listed as such, its size and shape
// are bounded so reading it costs little whatever it holds, and nothing from it is ever run.

/** A document bigger than this is not the API's, and is not read past it. */
export const MAX_SPEC_BYTES = 8 * 1024 * 1024;

/** The most operations an API's document lists, and the most parameters one operation takes. */
const MAX_OPERATIONS = 2_000;
const MAX_TAGS = 500;
const MAX_PARAMETERS = 100;
/** The longest `$ref` followed: the API's are under 80 characters. */
const MAX_REF_CHARS = 200;
/** The most names a JSON answer's schema may require, for the check that an answer holds them. */
const MAX_REQUIRED = 50;

/** The methods the SDK sends. */
type Method = "GET" | "POST";

/** One operation's example request, ready to send. */
export interface ExampleRequest {
  kind: "request";
  /** The service's name, as `haau3 test <service>` takes it. */
  service: string;
  operationId: string;
  method: Method;
  /** The path as the spec writes it, `{id}` left in: what is printed, never a value. */
  path: string;
  pathParams: Record<string, string>;
  /** Each query parameter's values, as text; a list is sent once per value. */
  query: Record<string, string[]>;
  /** The request body's example, for a POST: JSON text when the example is itself a string. */
  body: unknown;
  /** The FHIR resource types a success is documented as; empty for an answer that is not FHIR. */
  expects: string[];
  /** For an answer documented as plain JSON: the names its object must hold. Null for a FHIR answer. */
  requires: string[] | null;
  /** How many requests sending it counts as when it is answered: a batch counts each entry. */
  requests: number;
}

/** An operation the command line found but cannot send, and why. */
export interface Unbuildable {
  kind: "unbuildable";
  service: string;
  /** Its operationId, or null when that is not a plain name. */
  operationId: string | null;
  why: string;
}

export type Operation = ExampleRequest | Unbuildable;

export interface Service {
  /** `provider-directory`: the tag in lower case, with hyphens for spaces. */
  name: string;
  /** The tag as the spec writes it, the first time it appears. */
  tag: string;
  /** Every operation, in the document's order, whether or not it can be sent. */
  operations: Operation[];
}

export type SpecRead =
  | {
      ok: true;
      version: string | null;
      services: Service[];
      /** Operations left out because their tag is missing or not a plain name: counted, never named. */
      skipped: number;
    }
  | { ok: false; why: string };

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

/** A tag as a person types it: `Provider directory` is `provider-directory`. */
export function serviceName(tag: string): string {
  return tag
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// What may be printed from the document: plain names only.
const PLAIN_TAG = /^[A-Za-z][A-Za-z0-9 -]{0,40}$/;
const PLAIN_NAME = /^[a-z][a-z0-9-]{0,40}$/;
const PLAIN_OPERATION = /^[A-Za-z][A-Za-z0-9]{0,63}$/;
const PLAIN_PATH = /^\/[A-Za-z0-9/{}$._-]{0,200}$/;
const PLAIN_VERSION = /^[0-9A-Za-z.+-]{1,40}$/;
const PLAIN_TYPE = /^[A-Z][A-Za-z]{0,63}$/;
const PLAIN_PARAMETER = /^[A-Za-z_][A-Za-z0-9_.:-]{0,64}$/;
/** A path's `{name}`, as the SDK reads one: any name that is not empty. */
const PLACEHOLDER = /\{([^{}]+)\}/g;

/** Whether a path is plain, and every segment of it is a segment: none empty, `.` or `..`, no stray brace. */
function plainPath(path: string): boolean {
  if (!PLAIN_PATH.test(path)) return false;
  if (/[{}]/.test(path.replace(PLACEHOLDER, ""))) return false;
  return path
    .slice(1)
    .split("/")
    .every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/** A `$ref` inside the document, followed a few steps at most and only when short. Any other is not followed. */
function deref(doc: Json, value: unknown): unknown {
  let current = value;
  for (let step = 0; step < 8 && isObject(current) && typeof current.$ref === "string"; step++) {
    const ref = current.$ref;
    if (!ref.startsWith("#/") || ref.length > MAX_REF_CHARS) return undefined;
    let next: unknown = doc;
    for (const part of ref.slice(2).split("/")) {
      const key = part.replace(/~1/g, "/").replace(/~0/g, "~");
      next = isObject(next) && Object.hasOwn(next, key) ? next[key] : undefined;
    }
    current = next;
  }
  return isObject(current) && typeof current.$ref === "string" ? undefined : current;
}

type Scalar = string | number | boolean;
const isScalar = (value: unknown): value is Scalar =>
  typeof value === "string" || (typeof value === "number" && Number.isFinite(value)) || typeof value === "boolean";

/** The 200's content, by media type. */
function okContent(operation: Json): Json | undefined {
  const ok = isObject(operation.responses) ? operation.responses["200"] : undefined;
  return isObject(ok) && isObject(ok.content) ? ok.content : undefined;
}

/** The FHIR resource types a 200 is documented as: `#/components/schemas/Bundle`, or a `oneOf` of them. */
function expectsOf(operation: Json): string[] {
  const content = okContent(operation);
  const fhir = content && isObject(content["application/fhir+json"]) ? content["application/fhir+json"] : undefined;
  if (!fhir || !isObject(fhir.schema)) return [];
  const schemas = Array.isArray(fhir.schema.oneOf) ? fhir.schema.oneOf.slice(0, 20) : [fhir.schema];
  const names = schemas.map((s) => (isObject(s) && typeof s.$ref === "string" ? s.$ref.split("/").pop() : undefined));
  return names.every((n): n is string => n !== undefined && PLAIN_TYPE.test(n)) ? names : [];
}

/** For a 200 documented as plain JSON: the names its object's schema requires. Null for any other answer. */
function requiresOf(doc: Json, operation: Json): string[] | null {
  const content = okContent(operation);
  if (!content || content["application/fhir+json"] !== undefined) return null;
  const plain = isObject(content["application/json"]) ? content["application/json"] : undefined;
  if (!plain) return null;
  const schema = deref(doc, plain.schema);
  const required = isObject(schema) && Array.isArray(schema.required) ? schema.required.slice(0, MAX_REQUIRED) : [];
  return required.filter((name): name is string => typeof name === "string" && PLAIN_PARAMETER.test(name));
}

/** The request body's one example, when the operation takes a body. */
function bodyOf(doc: Json, operation: Json): { has: boolean; required: boolean; value?: unknown } {
  const requestBody = deref(doc, operation.requestBody);
  if (!isObject(requestBody)) return { has: false, required: false };
  const content = isObject(requestBody.content) ? requestBody.content : {};
  for (const media of Object.values(content).slice(0, 10)) {
    if (!isObject(media)) continue;
    if (media.example !== undefined) return { has: true, required: requestBody.required === true, value: media.example };
    const first = isObject(media.examples) ? Object.values(media.examples)[0] : undefined;
    const example = deref(doc, first);
    if (isObject(example) && example.value !== undefined) return { has: true, required: requestBody.required === true, value: example.value };
  }
  return { has: false, required: requestBody.required === true };
}

/** How many requests a body counts as when answered: a batch counts one for each entry. */
function requestsOf(body: unknown): number {
  return isObject(body) && body.resourceType === "Bundle" && body.type === "batch" && Array.isArray(body.entry) ? Math.max(1, body.entry.length) : 1;
}

/** One operation's example request, or why it cannot be built. */
function build(doc: Json, service: string, path: string, method: Method, item: Json, operation: Json): Omit<ExampleRequest, "kind" | "service"> | string {
  const operationId = operation.operationId;
  if (typeof operationId !== "string" || !PLAIN_OPERATION.test(operationId)) return "its operationId is not a plain name";
  if (!plainPath(path)) return "its path is not plain text";
  const listed = [...(Array.isArray(item.parameters) ? item.parameters : []), ...(Array.isArray(operation.parameters) ? operation.parameters : [])];
  if (listed.length > MAX_PARAMETERS) return "it lists more parameters than an operation takes";
  // An operation's own parameter replaces the path's of the same name and place, as OpenAPI says.
  const byPlace = new Map<string, Json>();
  for (const raw of listed) {
    const parameter = deref(doc, raw);
    if (!isObject(parameter) || typeof parameter.name !== "string") return "a parameter has no name";
    // A name is repeated in the reason an operation cannot be sent, so it must be plain to be named at all.
    if (!PLAIN_PARAMETER.test(parameter.name)) return "a parameter's name is not plain text";
    byPlace.set(`${String(parameter.in)}:${parameter.name}`, parameter);
  }
  // Objects with no prototype, so no name from the document is read as one of an object's own.
  const pathParams: Record<string, string> = Object.create(null);
  const query: Record<string, string[]> = Object.create(null);
  const placeholders = new Set([...path.matchAll(PLACEHOLDER)].map((match) => match[1]!));
  for (const parameter of byPlace.values()) {
    const name = parameter.name as string;
    const { example } = parameter;
    if (parameter.in === "path") {
      if (!placeholders.has(name)) return `its path has no {${name}} for its path parameter`;
      if (!isScalar(example)) return `{${name}} has no example`;
      pathParams[name] = String(example);
    } else if (parameter.in === "query") {
      if (example === undefined) {
        if (parameter.required === true) return `the required query parameter ${name} has no example`;
        continue;
      }
      const values = Array.isArray(example) ? example.slice(0, 100) : [example];
      if (!values.every(isScalar)) return `the query parameter ${name}'s example is not a value`;
      if (parameter.required === true && values.length === 0) return `the required query parameter ${name}'s example has no value`;
      query[name] = values.map(String);
    } else if (parameter.in === "header" && parameter.required === true) {
      // A header parameter is never sent: a header can carry a credential, and none is an example's.
      return `it needs the header ${name}, which haau3 does not send`;
    }
  }
  for (const name of placeholders) if (!Object.hasOwn(pathParams, name)) return `{${name}} has no example`;
  const body = bodyOf(doc, operation);
  if (method === "GET" && body.has) return "a GET with a body";
  if (body.required && !body.has) return "its request body has no example";
  // An example that is a string is sent as JSON text, as the docs' samples send it; the SDK sends a string as it is.
  const value = typeof body.value === "string" ? JSON.stringify(body.value) : body.value;
  return { operationId, method, path, pathParams, query, body: value, expects: expectsOf(operation), requires: requiresOf(doc, operation), requests: requestsOf(body.value) };
}

/** Reads a parsed document: its version, and its services in the order its tags are declared. */
export function readSpec(doc: unknown): SpecRead {
  if (!isObject(doc) || typeof doc.openapi !== "string" || !doc.openapi.startsWith("3.") || !isObject(doc.paths)) {
    return { ok: false, why: "it is not an OpenAPI 3 document" };
  }
  const info = isObject(doc.info) ? doc.info : {};
  const version = typeof info.version === "string" && PLAIN_VERSION.test(info.version) ? info.version : null;
  const declared = Array.isArray(doc.tags) ? doc.tags : [];
  const pathItems = Object.entries(doc.paths);
  if (declared.length > MAX_TAGS || pathItems.length > MAX_OPERATIONS) return { ok: false, why: "it lists more than an API's spec does" };

  // Keyed by the name a person types, so two spellings of one tag are one service.
  const byName = new Map<string, Service>();
  const serviceFor = (tag: unknown): Service | null => {
    if (typeof tag !== "string" || !PLAIN_TAG.test(tag)) return null;
    const name = serviceName(tag);
    if (!PLAIN_NAME.test(name)) return null;
    if (!byName.has(name)) byName.set(name, { name, tag, operations: [] });
    return byName.get(name)!;
  };
  for (const tag of declared) if (isObject(tag)) serviceFor(tag.name);

  let operations = 0;
  let skipped = 0;
  for (const [path, item] of pathItems) {
    if (!isObject(item)) continue;
    // Each path item's GET and POST in the order the document writes them.
    for (const key of Object.keys(item)) {
      if (key !== "get" && key !== "post") continue;
      const operation = item[key];
      if (!isObject(operation) || operation.deprecated === true) continue;
      if (++operations > MAX_OPERATIONS) return { ok: false, why: "it lists more than an API's spec does" };
      const service = serviceFor(Array.isArray(operation.tags) ? operation.tags[0] : undefined);
      if (!service) {
        skipped++;
        continue;
      }
      const built = build(doc, service.name, path, key === "get" ? "GET" : "POST", item, operation);
      if (typeof built === "string") {
        const id = typeof operation.operationId === "string" && PLAIN_OPERATION.test(operation.operationId) ? operation.operationId : null;
        service.operations.push({ kind: "unbuildable", service: service.name, operationId: id, why: built });
      } else {
        service.operations.push({ kind: "request", service: service.name, ...built });
      }
    }
  }
  // A tag with no operation that is not deprecated, as the Sandbox tag on production's, is no service.
  const services = [...byName.values()].filter((s) => s.operations.length > 0);
  if (services.length === 0) return { ok: false, why: "it lists no operation haau3 can call" };
  return { ok: true, version, services, skipped };
}
