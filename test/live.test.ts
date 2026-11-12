// Live, and only when HAAU3_LIVE_TEST=1: each host's published spec, read as test reads it, builds an
// example request for every operation it lists, so an operation published without the examples its
// request needs is caught here. It reads /openapi.json only, which needs no key and counts toward no
// allowance, and sends no call. Node's own https, since every test's fetch refuses other hosts.
import { get } from "node:https";
import { describe, expect, it } from "vitest";
import { readSpec } from "../src/spec.js";

const LIVE = process.env.HAAU3_LIVE_TEST === "1";

function read(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    get(url, { headers: { accept: "application/json", "user-agent": "haau3-cli-live-test" } }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (text += chunk));
      res.on("end", () => (res.statusCode === 200 ? resolve(JSON.parse(text)) : reject(new Error(`${url} answered ${res.statusCode}`))));
    }).on("error", reject);
  });
}

describe.skipIf(!LIVE)("each host's published spec builds every operation's example request", () => {
  for (const host of ["https://api.haau3.com", "https://sandbox.haau3.com"]) {
    it(host, async () => {
      const spec = readSpec(await read(`${host}/openapi.json`));
      if (!spec.ok) throw new Error(spec.why);
      expect(spec.version).toMatch(/^1\.0\.0-preview\.\d+$/);
      expect(spec.unbuildable).toEqual([]);
      expect(spec.services.length).toBeGreaterThanOrEqual(9);
      for (const service of spec.services) expect(service.operations.length, service.name).toBeGreaterThan(0);
    });
  }
});
