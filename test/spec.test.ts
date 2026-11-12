// Reading the published spec: each operation's example request is every parameter that carries an
// example and no other, and the body's one example; the services are the tags, in their declared
// order; what cannot be sent is listed, and nothing that is not a plain name is printed.
import { describe, expect, it } from "vitest";
import { readSpec, serviceName } from "../src/spec.js";

const fhir = (type: string) => ({ "200": { description: "ok", content: { "application/fhir+json": { schema: { $ref: `#/components/schemas/${type}` } } } } });

function doc(paths: Record<string, unknown>, tags = ["Terminology", "Provider directory"], extra: Record<string, unknown> = {}) {
  return { openapi: "3.1.0", info: { title: "API", version: "1.0.0-preview.9" }, tags: tags.map((name) => ({ name })), paths, ...extra };
}

describe("serviceName", () => {
  it("is the tag in lower case, with hyphens for spaces", () => {
    expect(serviceName("Provider directory")).toBe("provider-directory");
    expect(serviceName("FHIR base")).toBe("fhir-base");
    expect(serviceName("MedList")).toBe("medlist");
    expect(serviceName("  Structured Sig ")).toBe("structured-sig");
  });
});

describe("readSpec", () => {
  it("builds the example request from the parameters that carry an example, and no other", () => {
    const read = readSpec(
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
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.version).toBe("1.0.0-preview.9");
    const [op] = read.services[0]!.operations;
    expect(op).toEqual({
      service: "terminology",
      operationId: "codeSystemLookup",
      method: "GET",
      path: "/v1/fhir/r4/CodeSystem/$lookup",
      pathParams: {},
      query: { code: ["2345-7"], system: ["http://loinc.org"], _count: ["2"], npi: ["1", "2"] },
      body: undefined,
      expects: ["Parameters"],
      requests: 1,
    });
  });

  it("fills a path from its parameter's example, follows $refs, and reads the body's one example", () => {
    const read = readSpec({
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
    if (!read.ok) throw new Error(read.why);
    const all = read.services.flatMap((s) => s.operations);
    expect(all.find((o) => o.operationId === "readPractitioner")?.pathParams).toEqual({ id: "Practitioner-1" });
    const batch = all.find((o) => o.operationId === "fhirBatch")!;
    expect(batch.body).toEqual({ resourceType: "Bundle", type: "batch", entry: [{}, {}, {}] });
    // A batch counts one request for each of its entries.
    expect(batch.requests).toBe(3);
  });

  it("orders services by their declared tags, operations by the document, and skips what is deprecated", () => {
    const read = readSpec(
      doc(
        {
          "/b": { get: { tags: ["Provider directory"], operationId: "second", responses: {} } },
          "/a": { get: { tags: ["Terminology"], operationId: "first", responses: {} }, post: { tags: ["Terminology"], operationId: "later", responses: {} } },
          "/old": { get: { tags: ["Old"], operationId: "gone", deprecated: true, responses: {} } },
        },
        ["Terminology", "Provider directory", "Old"],
      ),
    );
    if (!read.ok) throw new Error(read.why);
    expect(read.services.map((s) => [s.name, s.operations.map((o) => o.operationId)])).toEqual([
      ["terminology", ["first", "later"]],
      ["provider-directory", ["second"]],
    ]);
  });

  it("lists what cannot be built, with why, and builds the rest", () => {
    const read = readSpec(
      doc({
        "/v1/x/{id}": { get: { tags: ["Terminology"], operationId: "noPathExample", parameters: [{ in: "path", name: "id", required: true }], responses: {} } },
        "/v1/y": { get: { tags: ["Terminology"], operationId: "noRequiredExample", parameters: [{ in: "query", name: "code", required: true }], responses: {} } },
        "/v1/z": { post: { tags: ["Terminology"], operationId: "noBody", requestBody: { required: true, content: { "application/json": {} } }, responses: {} } },
        "/v1/w": { get: { tags: ["Terminology"], operationId: "objectExample", parameters: [{ in: "query", name: "q", example: { a: 1 } }], responses: {} } },
        "/v1/ok": { get: { tags: ["Terminology"], operationId: "fine", responses: {} } },
      }),
    );
    if (!read.ok) throw new Error(read.why);
    expect(read.services[0]!.operations.map((o) => o.operationId)).toEqual(["fine"]);
    expect(read.unbuildable).toEqual([
      { service: "terminology", operationId: "noPathExample", why: "{id} has no example" },
      { service: "terminology", operationId: "noRequiredExample", why: "the required query parameter code has no example" },
      { service: "terminology", operationId: "noBody", why: "its request body has no example" },
      { service: "terminology", operationId: "objectExample", why: "the query parameter q's example is not a value" },
    ]);
  });

  it("never names what is not plain: an operation id, a parameter, a path, a tag or a version", () => {
    const read = readSpec({
      openapi: "3.1.0",
      info: { version: "1.0\u001b[31m" },
      tags: [{ name: "Ok" }, { name: "Bad\u001b]8;;x\u0007" }],
      paths: {
        "/v1/a": { get: { tags: ["Ok"], operationId: "evil\u001b[2J", responses: {} } },
        "/v1/b": { get: { tags: ["Ok"], operationId: "param", parameters: [{ in: "query", name: "x\u001b[0m", example: "1" }], responses: {} } },
        "/v1/c\u0007": { get: { tags: ["Ok"], operationId: "path", responses: {} } },
        "/v1/d": { get: { tags: ["Bad\u001b]8;;x\u0007"], operationId: "tagged", responses: {} } },
      },
    });
    if (!read.ok) throw new Error(read.why);
    expect(read.version).toBeNull();
    expect(read.services.map((s) => s.name)).toEqual(["ok"]);
    expect(read.services[0]!.operations).toEqual([]);
    expect(read.unbuildable).toEqual([
      { service: "ok", operationId: null, why: "its operationId is not a plain name" },
      { service: "ok", operationId: "param", why: "a parameter's name is not plain text" },
      { service: "ok", operationId: "path", why: "its path is not plain text" },
    ]);
    // JSON.stringify writes a control character as an escape, so the escapes are what to look for.
    expect(JSON.stringify(read)).not.toContain("\\u001b");
    expect(JSON.stringify(read)).not.toContain("\\u0007");
  });

  it("refuses what is not an OpenAPI 3 document", () => {
    for (const notOne of [null, "text", [], { swagger: "2.0", paths: {} }, { openapi: "3.1.0" }]) {
      expect(readSpec(notOne)).toEqual({ ok: false, why: "it is not an OpenAPI 3 document" });
    }
  });

  it("does not follow a $ref outside the document", () => {
    const read = readSpec(
      doc({ "/v1/a/{id}": { get: { tags: ["Terminology"], operationId: "remote", parameters: [{ $ref: "https://elsewhere.example/p.json" }], responses: {} } } }),
    );
    if (!read.ok) throw new Error(read.why);
    expect(read.unbuildable).toEqual([{ service: "terminology", operationId: "remote", why: "a parameter has no name" }]);
  });
});
