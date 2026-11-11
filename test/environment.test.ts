// The one place a call's address is decided.
import { describe, expect, it } from "vitest";
import { DEFAULT_BASE_URL, resolveTarget } from "../src/environment.js";

describe("where a call goes", () => {
  it("is the API's address by default, for both environments", () => {
    expect(DEFAULT_BASE_URL).toBe("https://api.haau3.com");
    expect(resolveTarget("production", {})).toEqual({ ok: true, target: { environment: "production", baseURL: "https://api.haau3.com" } });
    expect(resolveTarget("sandbox", {})).toEqual({ ok: true, target: { environment: "sandbox", baseURL: "https://api.haau3.com" } });
  });

  it("follows HAAU3_BASE_URL, the SDKs' own variable, without a trailing slash", () => {
    expect(resolveTarget("production", { HAAU3_BASE_URL: "https://api.example.com/" })).toEqual({
      ok: true,
      target: { environment: "production", baseURL: "https://api.example.com" },
    });
    expect(resolveTarget("sandbox", { HAAU3_BASE_URL: " https://example.com/haau3/ " })).toEqual({
      ok: true,
      target: { environment: "sandbox", baseURL: "https://example.com/haau3" },
    });
  });

  it("allows http on this computer only", () => {
    for (const local of ["http://localhost:8787", "http://127.0.0.1:8787", "http://[::1]:8787"]) {
      expect(resolveTarget("production", { HAAU3_BASE_URL: local }).ok, local).toBe(true);
    }
    const remote = resolveTarget("production", { HAAU3_BASE_URL: "http://api.example.com" });
    expect(remote).toMatchObject({ ok: false, error: { code: "invalid-base-url", message: "HAAU3_BASE_URL is neither https nor http on this computer." } });
  });

  it("refuses an address that is not one, or that carries a password, a query or a fragment, and never repeats it", () => {
    for (const [value, why] of [
      ["not an address", "is not an address"],
      ["https://someone:hunter2xyz@api.example.com", "carries a user name or password"],
      ["https://api.example.com/?token=hunter2xyz", "carries a query or a fragment"],
      ["https://api.example.com/#hunter2xyz", "carries a query or a fragment"],
      ["ftp://api.example.com", "is neither https nor http on this computer"],
    ]) {
      const result = resolveTarget("production", { HAAU3_BASE_URL: value });
      expect(result.ok, value).toBe(false);
      if (result.ok) continue;
      expect(result.error.message).toBe(`HAAU3_BASE_URL ${why}.`);
      expect(JSON.stringify(result)).not.toContain("hunter2xyz");
      expect(result.error.next[0]?.command).toBe("unset HAAU3_BASE_URL");
    }
  });
});
