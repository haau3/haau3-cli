// The pieces of signing in on their own: where the metadata lives (RFC 9728, RFC 8414), what is read
// from a refusal, and how the platform's description of a session is checked.
import { describe, expect, it } from "vitest";
import { authorizationServerMetadataURL, resourceMetadataURL, resourceOf } from "../src/signin/discovery.js";
import { problemOf, retryAfterSeconds, text } from "../src/signin/http.js";
import { parseWhoami } from "../src/signin/whoami.js";
import { WHOAMI } from "./fake-server.js";

describe("where the metadata lives", () => {
  it("puts the well-known segment between the host and the path (RFC 9728, section 3.1)", () => {
    expect(resourceOf("https://platform.haau3.com")).toBe("https://platform.haau3.com/api/cli/v1");
    expect(resourceMetadataURL("https://platform.haau3.com/api/cli/v1")).toBe("https://platform.haau3.com/.well-known/oauth-protected-resource/api/cli/v1");
    expect(resourceMetadataURL("http://localhost:3002/prefix/api/cli/v1")).toBe("http://localhost:3002/.well-known/oauth-protected-resource/prefix/api/cli/v1");
  });

  it("does the same for the issuer (RFC 8414, section 3.1)", () => {
    expect(authorizationServerMetadataURL("https://auth.example.com")).toBe("https://auth.example.com/.well-known/oauth-authorization-server");
    expect(authorizationServerMetadataURL("https://auth.example.com/")).toBe("https://auth.example.com/.well-known/oauth-authorization-server");
    expect(authorizationServerMetadataURL("https://example.com/tenant")).toBe("https://example.com/.well-known/oauth-authorization-server/tenant");
  });
});

describe("a refusal", () => {
  const answer = (body: unknown, headers: Record<string, string> = {}) => ({ status: 403, headers: new Headers(headers), body });

  it("gives its type, title, status, code and request id, never its detail", () => {
    const problem = problemOf(answer({ type: "about:blank", title: "Forbidden", status: 403, detail: "secret detail", code: "not-a-member" }, { "X-Request-Id": "req_123" }));
    expect(problem).toEqual({ type: "about:blank", title: "Forbidden", status: 403, code: "not-a-member", requestId: "req_123" });
  });

  it("leaves out a code or a request id that is not shaped like one, and copes with no body", () => {
    expect(problemOf(answer({ code: "Not A Code!" }, { "X-Request-Id": "has spaces" }))).toEqual({ type: "about:blank", title: "HTTP 403", status: 403 });
    expect(problemOf(answer(undefined))).toEqual({ type: "about:blank", title: "HTTP 403", status: 403 });
  });

  it("reads Retry-After in seconds only", () => {
    expect(retryAfterSeconds(new Headers({ "Retry-After": "30" }))).toBe(30);
    expect(retryAfterSeconds(new Headers({ "Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT" }))).toBeUndefined();
    expect(retryAfterSeconds(new Headers())).toBeUndefined();
  });

  it("takes no text with control characters, or too long", () => {
    expect(text("fine")).toBe("fine");
    expect(text("line\nbreak")).toBeUndefined();
    expect(text("x".repeat(301))).toBeUndefined();
    expect(text("")).toBeUndefined();
    expect(text(5)).toBeUndefined();
  });
});

describe("the platform's description of a session", () => {
  const body = { ...WHOAMI, session: { expiresAt: "2026-11-11T19:00:00.000Z" } };

  it("is read whole", () => {
    expect(parseWhoami(body)).toEqual(body);
  });

  it("takes a member with no email, an organization with no slug, and no usage", () => {
    const sparse = { ...body, member: { id: "user_1", email: null }, organization: { id: "org_1", name: "Org", slug: null }, usage: null };
    expect(parseWhoami(sparse)).toEqual(sparse);
  });

  it("carries a plan it does not know yet, rather than refusing it", () => {
    expect(parseWhoami({ ...body, plan: { tier: "galactic", name: "Galactic" } })?.plan.tier).toBe("galactic");
  });

  it("refuses a shape it cannot trust", () => {
    expect(parseWhoami(null)).toBeUndefined();
    expect(parseWhoami({ ...body, session: { expiresAt: "soon" } })).toBeUndefined();
    expect(parseWhoami({ ...body, usage: { count: -1, allowance: 1000, headline: "x" } })).toBeUndefined();
    expect(parseWhoami({ ...body, usage: { count: 1, allowance: 0, headline: "x" } })).toBeUndefined();
    expect(parseWhoami({ ...body, member: { id: "user_1" } })).toBeUndefined();
    expect(parseWhoami({ ...body, role: "a\nrole" })).toBeUndefined();
  });
});
