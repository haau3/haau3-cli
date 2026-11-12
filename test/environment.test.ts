// The rule every address the command line is given keeps. Where an API call goes is the SDK's to
// decide; doctor's tests cover how HAAU3_BASE_URL reaches it.
import { describe, expect, it } from "vitest";
import { checkAddress, ENVIRONMENT_ADDRESSES } from "../src/environment.js";

describe("an address the command line is given", () => {
  it("names each environment's own address as the SDK has it", () => {
    expect(ENVIRONMENT_ADDRESSES).toEqual({ production: "https://api.haau3.com", sandbox: "https://sandbox.haau3.com" });
  });

  it("is taken without a trailing slash or the spaces around it", () => {
    expect(checkAddress("https://api.example.com/")).toEqual({ ok: true, address: "https://api.example.com" });
    expect(checkAddress(" https://example.com/haau3/ ")).toEqual({ ok: true, address: "https://example.com/haau3" });
  });

  it("may be http on this computer only", () => {
    for (const local of ["http://localhost:8787", "http://127.0.0.1:8787", "http://[::1]:8787"]) {
      expect(checkAddress(local).ok, local).toBe(true);
    }
    expect(checkAddress("http://api.example.com")).toEqual({ ok: false, why: "is neither https nor http on this computer" });
  });

  it("is refused when it is not one, or carries a password, a query or a fragment, and never repeated", () => {
    for (const [value, why] of [
      ["not an address", "is not an address"],
      ["https://someone:hunter2xyz@api.example.com", "carries a user name or password"],
      ["https://api.example.com/?token=hunter2xyz", "carries a query or a fragment"],
      ["https://api.example.com/#hunter2xyz", "carries a query or a fragment"],
      ["ftp://api.example.com", "is neither https nor http on this computer"],
    ]) {
      const result = checkAddress(value!);
      expect(result, value).toEqual({ ok: false, why });
      expect(JSON.stringify(result)).not.toContain("hunter2xyz");
    }
  });
});
