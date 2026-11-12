// The published spec, read at run time from the host the calls go to, and each operation's example
// request built from it: every parameter that carries an `example`, and no other, and the body's one
// example. That is the request the docs' samples send and the Sandbox answers. Nothing here is kept
// by hand, so a new operation needs no new release of the command line.
//
// The document comes from the API's own host, or from wherever HAAU3_BASE_URL points, which can be
// anything: so it is read as untrusted data. A name from it is printed only when it is plain, an
// operation it describes in a way the command line cannot send is listed as such, and nothing from
// it is ever run.

/** A document bigger than this is not the API's, and is not read. */
export const MAX_SPEC_CHARS = 8 * 1024 * 1024;

/** The methods the SDK sends. */
type Method = "GET" | "POST";

/** One operation's example request, ready to send. */
export interface ExampleRequest {
  /** The service's name, as `haau3 test <service>` takes it. */
  service: string;
  operationId: string;
  method: Method;
  /** The path as the spec writes it, `{id}` left in: what is printed, never a value. */
  path: string;
  pathParams: Record<string, string>;
  /** Each query parameter's values, as text; a list is sent once per value. */
  query: Record<string, string[]>;
  /** The request body's example, for a POST. */
  body: unknown;
  /** The FHIR resource types a success is documented as; empty for an answer that is not FHIR. */
  expects: string[];
  /** How many requests sending it counts as: a batch counts each entry. */
  requests: number;
}

/** An operation the command line found but cannot send, and why. */
export interface Unbuildable {
  service: string;
  /** Its operationId, or null when that is not a plain name. */
  operationId: string | null;
  why: string;
}

export interface Service {
  /** `provider-directory`: the tag in lower case, with hyphens for spaces. */
  name: string;
  /** The tag as the spec writes it, when it is plain. */
  tag: string;
  /** Every operation that can be sent, in the document's order. */
  operations: ExampleRequest[];
}

export type SpecRead =
  | { ok: true; version: string | null; services: Service[]; unbuildable: Unbuildable[] }
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
const PLAIN_TAG = /^[A-Za-z][A-Za-z0-9 ]{0,40}$/;
const PLAIN_NAME = /^[a-z][a-z0-9-]{0,40}$/;
const PLAIN_OPERATION = /^[A-Za-z][A-Za-z0-9]{0,63}$/;
const PLAIN_PATH = /^\/[A-Za-z0-9/{}$._-]{0,200}$/;
const PLAIN_VERSION = /^[0-9A-Za-z.+-]{1,40}$/;
const PLAIN_TYPE = /^[A-Z][A-Za-z]{0,63}$/;
const PLAIN_PARAMETER = /^[A-Za-z_][A-Za-z0-9_.:-]{0,64}$/;
const PLACEHOLDER = /\{([A-Za-z0-9_]+)\}/g;

/** A `$ref` inside the document, followed a few steps at most. Any other is not followed. */
function deref(doc: Json, value: unknown): unknown {
  let current = value;
  for (let step = 0; step < 8 && isObject(current) && typeof current.$ref === "string"; step++) {
    const ref = current.$ref;
    if (!ref.startsWith("#/")) return undefined;
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

/** The FHIR resource types a 200 is documented as: `#/components/schemas/Bundle`, or a `oneOf` of them. */
function expectsOf(operation: Json): string[] {
  const ok = isObject(operation.responses) ? operation.responses["200"] : undefined;
  const content = isObject(ok) && isObject(ok.content) ? ok.content : undefined;
  const fhir = content && isObject(content["application/fhir+json"]) ? content["application/fhir+json"] : undefined;
  if (!fhir || !isObject(fhir.schema)) return [];
  const schemas = Array.isArray(fhir.schema.oneOf) ? fhir.schema.oneOf : [fhir.schema];
  const names = schemas.map((s) => (isObject(s) && typeof s.$ref === "string" ? s.$ref.split("/").pop() : undefined));
  return names.every((n): n is string => n !== undefined && PLAIN_TYPE.test(n)) ? names : [];
}

/** The request body's one example, when the operation takes a body. */
function bodyOf(doc: Json, operation: Json): { has: boolean; required: boolean; value?: unknown } {
  const requestBody = deref(doc, operation.requestBody);
  if (!isObject(requestBody)) return { has: false, required: false };
  const content = isObject(requestBody.content) ? requestBody.content : {};
  for (const media of Object.values(content)) {
    if (!isObject(media)) continue;
    if (media.example !== undefined) return { has: true, required: requestBody.required === true, value: media.example };
    const first = isObject(media.examples) ? Object.values(media.examples)[0] : undefined;
    const example = deref(doc, first);
    if (isObject(example) && example.value !== undefined) return { has: true, required: requestBody.required === true, value: example.value };
  }
  return { has: false, required: requestBody.required === true };
}

/** How many requests a body counts as: a batch counts one for each entry. */
function requestsOf(body: unknown): number {
  return isObject(body) && body.resourceType === "Bundle" && body.type === "batch" && Array.isArray(body.entry) ? Math.max(1, body.entry.length) : 1;
}

/** One operation's example request, or why it cannot be built. */
function build(doc: Json, service: string, path: string, method: Method, item: Json, operation: Json): ExampleRequest | string {
  const operationId = operation.operationId;
  if (typeof operationId !== "string" || !PLAIN_OPERATION.test(operationId)) return "its operationId is not a plain name";
  if (!PLAIN_PATH.test(path)) return "its path is not plain text";
  const parameters = [...(Array.isArray(item.parameters) ? item.parameters : []), ...(Array.isArray(operation.parameters) ? operation.parameters : [])].map((p) =>
    deref(doc, p),
  );
  const pathParams: Record<string, string> = {};
  const query: Record<string, string[]> = {};
  for (const parameter of parameters) {
    if (!isObject(parameter) || typeof parameter.name !== "string") return "a parameter has no name";
    // A name is repeated in the reason an operation cannot be sent, so it must be plain to be named at all.
    if (!PLAIN_PARAMETER.test(parameter.name)) return "a parameter's name is not plain text";
    const { name, example } = parameter;
    if (parameter.in === "path") {
      if (!isScalar(example)) return `{${name}} has no example`;
      pathParams[name] = String(example);
    } else if (parameter.in === "query") {
      if (example === undefined) {
        if (parameter.required === true) return `the required query parameter ${name} has no example`;
        continue;
      }
      const values = Array.isArray(example) ? example : [example];
      if (!values.every(isScalar)) return `the query parameter ${name}'s example is not a value`;
      query[name] = values.map(String);
    }
    // A header parameter is never sent: a header can carry a credential, and none is an example's.
  }
  for (const [, name] of path.matchAll(PLACEHOLDER)) if (!Object.hasOwn(pathParams, name!)) return `{${name}} has no example`;
  const body = bodyOf(doc, operation);
  if (method === "GET" && body.has) return "a GET with a body";
  if (body.required && !body.has) return "its request body has no example";
  return { service, operationId, method, path, pathParams, query, body: body.value, expects: expectsOf(operation), requests: requestsOf(body.value) };
}

/** Reads a parsed document: its version, and its services in the order its tags are declared. */
export function readSpec(doc: unknown): SpecRead {
  if (!isObject(doc) || typeof doc.openapi !== "string" || !doc.openapi.startsWith("3.") || !isObject(doc.paths)) {
    return { ok: false, why: "it is not an OpenAPI 3 document" };
  }
  const info = isObject(doc.info) ? doc.info : {};
  const version = typeof info.version === "string" && PLAIN_VERSION.test(info.version) ? info.version : null;

  const byTag = new Map<string, Service>();
  const declared = Array.isArray(doc.tags) ? doc.tags.map((t) => (isObject(t) && typeof t.name === "string" ? t.name : null)) : [];
  for (const tag of declared) {
    if (tag !== null && PLAIN_TAG.test(tag) && PLAIN_NAME.test(serviceName(tag)) && !byTag.has(tag)) byTag.set(tag, { name: serviceName(tag), tag, operations: [] });
  }
  const unbuildable: Unbuildable[] = [];
  for (const [path, item] of Object.entries(doc.paths)) {
    if (!isObject(item)) continue;
    for (const [key, method] of [["get", "GET"], ["post", "POST"]] as const) {
      const operation = item[key];
      if (!isObject(operation) || operation.deprecated === true) continue;
      const tag = Array.isArray(operation.tags) && typeof operation.tags[0] === "string" ? operation.tags[0] : null;
      if (tag === null || !PLAIN_TAG.test(tag) || !PLAIN_NAME.test(serviceName(tag))) continue;
      if (!byTag.has(tag)) byTag.set(tag, { name: serviceName(tag), tag, operations: [] });
      const service = byTag.get(tag)!;
      const built = build(doc, service.name, path, method, item, operation);
      if (typeof built === "string") {
        const id = typeof operation.operationId === "string" && PLAIN_OPERATION.test(operation.operationId) ? operation.operationId : null;
        unbuildable.push({ service: service.name, operationId: id, why: built });
      } else {
        service.operations.push(built);
      }
    }
  }
  // A tag with no operation that can be sent, as the deprecated Sandbox tag on production's, is no service.
  const services = [...byTag.values()].filter((s) => s.operations.length > 0 || unbuildable.some((u) => u.service === s.name));
  return { ok: true, version, services, unbuildable };
}
