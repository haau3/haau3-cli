import { defineConfig } from "tsdown";

// One ES module, the command line itself. Its one runtime dependency, the credential store's package,
// is loaded by a child process from the installed package's own folder, so nothing of it is bundled.
export default defineConfig({
  entry: ["src/cli.ts"],
  format: ["esm"],
  platform: "node",
  target: "node22",
  dts: false,
  clean: true,
  sourcemap: false,
});
