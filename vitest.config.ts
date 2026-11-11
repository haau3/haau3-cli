import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // The child-process tests start Node with tsx, which takes a few seconds on a cold Windows runner.
    testTimeout: 30_000,
  },
});
