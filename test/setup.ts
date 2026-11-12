// Runs before every test file. The SDK reads HAAU3_ENVIRONMENT and HAAU3_BASE_URL from this process's
// own environment when doctor finds neither, so a contributor's shell must not change where a test's
// calls go. And no test calls anything outside this computer: a fetch to any other host fails at once,
// so a test that forgot its stand-in fails rather than calling the real API.
for (const name of ["HAAU3_API_KEY", "HAAU3_ENVIRONMENT", "HAAU3_BASE_URL"]) delete process.env[name];

const LOCAL = new Set(["127.0.0.1", "localhost", "[::1]"]);
const realFetch = globalThis.fetch;
globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (!LOCAL.has(url.hostname)) return Promise.reject(new TypeError(`A test called ${url.host}. Tests call nothing outside this computer.`));
  return realFetch(input, init);
}) as typeof fetch;
