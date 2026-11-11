// The pieces of signing in on their own: where the metadata lives (RFC 9728, RFC 8414), what is read
// from a refusal, and how the platform's description of a session is checked.
import { describe, expect, it } from "vitest";
import { when } from "../src/commands/context.js";
import { page } from "../src/signin/device.js";
import { authorizationServerMetadataURL, resourceMetadataURL, resourceOf } from "../src/signin/discovery.js";
import { openBrowser, opener } from "../src/terminal.js";
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
    expect(parseWhoami({ ...body, member: { id: "user\n1", email: null } })).toBeUndefined();
  });

  it("shows a name with anything that could steer a terminal replaced, emoji joiners kept", () => {
    const name = "Acme\u009b31m\u202e Labs\u2028 \u{1F468}\u200d\u{1F4BB}";
    const read = parseWhoami({ ...body, organization: { id: "org_1", name, slug: null }, role: "a\nrole" });
    expect(read?.organization.name).toBe("Acme\ufffd31m\ufffd Labs\ufffd \u{1F468}\u200d\u{1F4BB}");
    expect(read?.role).toBe("a\ufffdrole");
  });
});

describe("the page a person opens", () => {
  it("is https with no query or fragment, as the parser reads it", () => {
    expect(page("https://auth.example.com/device", "https://platform.haau3.com")).toBe("https://auth.example.com/device");
    expect(page("https://AUTH.example.com/a/../device", "https://platform.haau3.com")).toBe("https://auth.example.com/device");
    expect(page("https://auth.example.com/device?user_code=WDJB-MJHT", "https://platform.haau3.com")).toBeUndefined();
    expect(page("https://auth.example.com/device#WDJB-MJHT", "https://platform.haau3.com")).toBeUndefined();
    expect(page("https://someone@auth.example.com/device", "https://platform.haau3.com")).toBeUndefined();
  });

  it("is http only on this computer, and only when the platform is too", () => {
    expect(page("http://127.0.0.1:3000/device", "http://127.0.0.1:3002")).toBe("http://127.0.0.1:3000/device");
    expect(page("http://127.0.0.1:3000/device", "https://platform.haau3.com")).toBeUndefined();
    expect(page("http://auth.example.com/device", "http://127.0.0.1:3002")).toBeUndefined();
  });
});

describe("the system's opener", () => {
  it("is named by its full path where it has a fixed one, so no project's file of that name runs", () => {
    expect(opener("darwin", {})).toEqual(["/usr/bin/open", []]);
    expect(opener("win32", { SystemRoot: "D:\\Windows" })).toEqual(["D:\\Windows\\System32\\rundll32.exe", ["url.dll,FileProtocolHandler"]]);
    expect(opener("win32", {})[0]).toBe("C:\\Windows\\System32\\rundll32.exe");
    expect(opener("linux", {})).toEqual(["xdg-open", []]);
  });

  it("says when it could not start", async () => {
    expect(await openBrowser("https://auth.example.com/device", "linux", { PATH: "/nonexistent" })).toBe(false);
    expect(await openBrowser("ftp://auth.example.com/", "darwin", {})).toBe(false);
  });
});

describe("a time to a person", () => {
  it("says how long until it, and only the clock once it has passed", () => {
    const now = Date.parse("2026-11-11T18:00:00Z");
    expect(when(now + 41 * 60_000, now)).toMatch(/, in 41 minutes$/);
    expect(when(now + 60_000, now)).toMatch(/, in 1 minute$/);
    expect(when(now + 10_000, now)).toMatch(/, in less than a minute$/);
    expect(when(now - 60_000, now)).not.toContain(" in ");
  });
});
