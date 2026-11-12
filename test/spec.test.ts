// Reading the published spec: each operation's example request is every parameter that carries an
// example and no other, and the body's one example; the services are the tags, in their declared
// order, each with its operations in the document's order, the unbuildable included with why; nothing
// that is not a plain name is named; and a hostile document costs little to read.
import { describe, expect, it } from "vitest";
import { readSpec, serviceName, type ExampleRequest, type Operation, type Service } from "../src/spec.js";

const fhir = (type: string) => ({ "200": { description: "ok", content: { "application/fhir+json": { schema: { $ref: `#/components/schemas/${type}` } } } } });

function doc(paths: Record<string, unknown>, tags = ["Terminology", "Provider directory"], extra: Record<string, unknown> = {}) {
  return { openapi: "3.1.0", info: { title: "API", version: "1.0.0-preview.9" }, tags: tags.map((name) => ({ name })), paths, ...extra };
}

function read(document: unknown) {
  const result = readSpec(document);
  if (!result.ok) throw new Error(result.why);
  return result;
}

const all = (services: Service[]): Operation[] => services.flatMap((s) => s.operations);
const request = (services: Service[], id: string) => all(services).find((o): o is ExampleRequest => o.kind === "request" && o.operationId === id)!;
const shape = (services: Service[]) => services.map((s) => [s.name, s.operations.map((o) => (o.kind === "request" ? o.operationId : `${o.operationId}: ${o.why}`))]);
const op = (tag: string, operationId: string, extra: Record<string, unknown> = {}) => ({ tags: [tag], operationId, responses: {}, ...extra });

describe("serviceName", () => {
  it("is the tag in lower case, with hyphens for spaces", () => {
    expect(serviceName("Provider directory")).toBe("provider-directory");
    expect(serviceName("FHIR base")).toBe("fhir-base");
    expect(serviceName("MedList")).toBe("medlist");
    expect(serviceName("  Structured Sig ")).toBe("structured-sig");
  });
});

describe("the example request", () => {
  it("is the parameters that carry an example, and no other", () => {
    const { version, services } = read(
      doc({
        "/v1/fhir/r4/CodeSystem/$lookup": {
          get: {
            tags: ["Terminology"],
            operationId: "codeSystemLookup",
            parameters: [
              { in: "query", name: "code", required: true, example: "2345-7" },
              { in: "query", name: "system", example: "http://loinc.org" },
              { in: "query", name: "version" },
              { in: "query", name: "_count", example: 2 },
              { in: "query", name: "npi", example: ["1", "2"] },
              { in: "header", name: "X-Request-Id", example: "not sent" },
            ],
            responses: fhir("Parameters"),
          },
        },
      }),
    );
    expect(version).toBe("1.0.0-preview.9");
    expect(services[0]!.operations[0]).toEqual({
      kind: "request",
      service: "terminology",
      operationId: "codeSystemLookup",
      method: "GET",
      path: "/v1/fhir/r4/CodeSystem/$lookup",
      pathParams: {},
      query: { code: ["2345-7"], system: ["http://loinc.org"], _count: ["2"], npi: ["1", "2"] },
      body: undefined,
      expects: ["Parameters"],
      requires: null,
      requests: 1,
    });
  });

  it("fills a path from its parameter's example, follows $refs, and reads the body's one example", () => {
    const { services } = read({
      ...doc({
        "/v1/fhir/r4/Practitioner/{id}": {
          parameters: [{ $ref: "#/components/parameters/id" }],
          get: { tags: ["Provider directory"], operationId: "readPractitioner", responses: fhir("Practitioner") },
        },
        "/v1/fhir/r4": {
          post: {
            tags: ["Terminology"],
            operationId: "fhirBatch",
            requestBody: { required: true, content: { "application/fhir+json": { examples: { one: { $ref: "#/components/examples/batch" } } } } },
            responses: fhir("Bundle"),
          },
        },
      }),
      components: {
        parameters: { id: { in: "path", name: "id", required: true, example: "Practitioner-1" } },
        examples: { batch: { value: { resourceType: "Bundle", type: "batch", entry: [{}, {}, {}] } } },
      },
    });
    expect(request(services, "readPractitioner").pathParams).toEqual({ id: "Practitioner-1" });
    const batch = request(services, "fhirBatch");
    expect(batch.body).toEqual({ resourceType: "Bundle", type: "batch", entry: [{}, {}, {}] });
    // A batch counts one request for each of its entries.
    expect(batch.requests).toBe(3);
  });

  it("lets an operation's own parameter replace the path's of the same name", () => {
    const { services } = read(
      doc({
        "/v1/x": {
          parameters: [{ in: "query", name: "q", example: "from-the-path" }],
          get: op("Terminology", "replaced", { parameters: [{ in: "query", name: "q" }] }),
          post: op("Terminology", "kept"),
        },
      }),
    );
    expect(request(services, "replaced").query).toEqual({});
    expect(request(services, "kept").query).toEqual({ q: ["from-the-path"] });
  });

  it("reads a query name such as __proto__ as a name, never as an object's own", () => {
    const { services } = read(doc({ "/v1/x": { get: op("Terminology", "odd", { parameters: [{ in: "query", name: "__proto__", required: true, example: ["x", "y"] }] }) } }));
    const query = request(services, "odd").query;
    expect(Object.getPrototypeOf(query)).toBeNull();
    expect(Object.entries(query)).toEqual([["__proto__", ["x", "y"]]]);
  });

  it("sends an example that is a string as JSON text", () => {
    const { services } = read(doc({ "/v1/x": { post: op("Terminology", "text", { requestBody: { required: true, content: { "application/json": { example: "plain text" } } } }) } }));
    expect(request(services, "text").body).toBe('"plain text"');
  });

  it("names what a plain JSON answer must hold, from its schema", () => {
    const { services } = read({
      ...doc({
        "/v1/things": { get: op("Terminology", "listThings", { responses: { "200": { content: { "application/json": { schema: { $ref: "#/components/schemas/List" } } } } } }) },
      }),
      components: { schemas: { List: { type: "object", required: ["things", "total", "bad\u001bname"] } } },
    });
    expect(request(services, "listThings").requires).toEqual(["things", "total"]);
  });
});

describe("services and their operations", () => {
  it("orders services by their declared tags, operations by the document, GET and POST as written, and skips what is deprecated", () => {
    const { services } = read(
      doc(
        {
          "/b": { get: op("Provider directory", "second") },
          "/a": { post: op("Terminology", "writtenFirst"), get: op("Terminology", "writtenSecond") },
          "/old": { get: op("Old", "gone", { deprecated: true }) },
        },
        ["Terminology", "Provider directory", "Old"],
      ),
    );
    expect(shape(services)).toEqual([
      ["terminology", ["writtenFirst", "writtenSecond"]],
      ["provider-directory", ["second"]],
    ]);
  });

  it("keeps two spellings of one tag as one service, and takes a tag with a dash", () => {
    const { services } = read(
      doc({ "/a": { get: op("Provider directory", "one") }, "/b": { get: op("Provider Directory", "two") }, "/c": { get: op("ICD-10-CM", "three") } }, ["Provider Directory"]),
    );
    expect(shape(services)).toEqual([
      ["provider-directory", ["one", "two"]],
      ["icd-10-cm", ["three"]],
    ]);
  });

  it("keeps what cannot be built in its place, with why", () => {
    const { services } = read(
      doc({
        "/v1/x/{id}": { get: op("Terminology", "noPathExample", { parameters: [{ in: "path", name: "id", required: true }] }) },
        "/v1/y": { get: op("Terminology", "noRequiredExample", { parameters: [{ in: "query", name: "code", required: true }] }) },
        "/v1/z": { post: op("Terminology", "noBody", { requestBody: { required: true, content: { "application/json": {} } } }) },
        "/v1/w": { get: op("Terminology", "objectExample", { parameters: [{ in: "query", name: "q", example: { a: 1 } }] }) },
        "/v1/ok": { get: op("Terminology", "fine") },
        "/v1/h": { get: op("Terminology", "needsHeader", { parameters: [{ in: "header", name: "X-Thing", required: true }] }) },
        "/v1/e": { get: op("Terminology", "emptyList", { parameters: [{ in: "query", name: "npi", required: true, example: [] }] }) },
        "/v1/p": { get: op("Terminology", "strayPathParameter", { parameters: [{ in: "path", name: "id", example: "x" }] }) },
      }),
    );
    expect(shape(services)).toEqual([
      [
        "terminology",
        [
          "noPathExample: {id} has no example",
          "noRequiredExample: the required query parameter code has no example",
          "noBody: its request body has no example",
          "objectExample: the query parameter q's example is not a value",
          "fine",
          "needsHeader: it needs the header X-Thing, which haau3 does not send",
          "emptyList: the required query parameter npi's example has no value",
          "strayPathParameter: its path has no {id} for its path parameter",
        ],
      ],
    ]);
  });

  it("never builds a path that leaves itself: an empty, '.' or '..' segment, or a stray brace", () => {
    const { services } = read(
      doc({
        "/v1/../outside": { get: op("Terminology", "dotDot") },
        "/v1/./here": { get: op("Terminology", "dot") },
        "/v1//twice": { get: op("Terminology", "empty") },
        "/v1/{open": { get: op("Terminology", "brace") },
      }),
    );
    expect(shape(services)[0]![1]).toEqual(["dotDot: its path is not plain text", "dot: its path is not plain text", "empty: its path is not plain text", "brace: its path is not plain text"]);
  });

  it("never names what is not plain: an operation id, a parameter, a path, a tag or a version", () => {
    const { version, services } = read({
      openapi: "3.1.0",
      info: { version: "1.0\u001b[31m" },
      tags: [{ name: "Ok" }, { name: "Bad\u001b]8;;x\u0007" }],
      paths: {
        "/v1/a": { get: op("Ok", "evil\u001b[2J") },
        "/v1/b": { get: op("Ok", "param", { parameters: [{ in: "query", name: "x\u001b[0m", example: "1" }] }) },
        "/v1/c\u0007": { get: op("Ok", "path") },
        "/v1/d": { get: op("Bad\u001b]8;;x\u0007", "tagged") },
      },
    });
    expect(version).toBeNull();
    expect(shape(services)).toEqual([
      ["ok", ["null: its operationId is not a plain name", "param: a parameter's name is not plain text", "path: its path is not plain text"]],
    ]);
    // JSON.stringify writes a control character as an escape, so the escapes are what to look for.
    expect(JSON.stringify(services)).not.toContain("\\u001b");
    expect(JSON.stringify(services)).not.toContain("\\u0007");
  });

  it("counts, never names, what it leaves out for a missing or unplain tag", () => {
    const result = read(doc({ "/a": { get: op("Terminology", "kept") }, "/b": { get: { operationId: "untagged", responses: {} } }, "/c": { get: op("Odd\u001b", "odd") } }));
    expect(result.skipped).toBe(2);
  });
});

describe("what is refused", () => {
  it("what is not an OpenAPI 3 document", () => {
    for (const notOne of [null, "text", [], { swagger: "2.0", paths: {} }, { openapi: "3.1.0" }]) {
      expect(readSpec(notOne)).toEqual({ ok: false, why: "it is not an OpenAPI 3 document" });
    }
  });

  it("a document with no operation haau3 can call", () => {
    expect(readSpec({ openapi: "3.0.0", paths: {} })).toEqual({ ok: false, why: "it lists no operation haau3 can call" });
    expect(readSpec(doc({ "/a": { get: { operationId: "untagged", responses: {} } } }))).toEqual({ ok: false, why: "it lists no operation haau3 can call" });
  });

  it("a $ref outside the document, or longer than an API's", () => {
    const long = `#/${"a".repeat(300)}`;
    const { services } = read(
      doc({
        "/v1/a/{id}": { get: op("Terminology", "remote", { parameters: [{ $ref: "https://elsewhere.example/p.json" }] }) },
        "/v1/b/{id}": { get: op("Terminology", "long", { parameters: [{ $ref: long }] }) },
      }),
    );
    expect(shape(services)[0]![1]).toEqual(["remote: a parameter has no name", "long: a parameter has no name"]);
  });

  it("more than an API's spec lists, quickly", () => {
    const many = Object.fromEntries(Array.from({ length: 2001 }, (_, i) => [`/v1/x${i}`, { get: op("Terminology", `op${i}`) }]));
    expect(readSpec(doc(many))).toEqual({ ok: false, why: "it lists more than an API's spec does" });
    const params = Array.from({ length: 101 }, (_, i) => ({ in: "query", name: `p${i}` }));
    expect(shape(read(doc({ "/v1/a": { get: op("Terminology", "wide", { parameters: params }) } })).services)[0]![1]).toEqual([
      "wide: it lists more parameters than an operation takes",
    ]);
    // Many references to one long one: each is refused before it is split, so this is fast.
    const target = `#/components/x/${"y".repeat(1_000_000)}`;
    const refs = Array.from({ length: 100 }, () => ({ $ref: target }));
    const started = performance.now();
    readSpec(doc({ "/v1/a": { get: op("Terminology", "refs", { parameters: refs.slice(0, 100) }) } }));
    expect(performance.now() - started).toBeLessThan(500);
  });
});
