import { defineConfig } from "tsdown";

// One ES module, the command line itself. It has no runtime dependency to leave out.
export default defineConfig({
  entry: ["src/cli.ts"],
  format: ["esm"],
  platform: "node",
  target: "node22",
  dts: false,
  clean: true,
  sourcemap: false,
});
