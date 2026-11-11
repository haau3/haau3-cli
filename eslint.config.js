import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/", "node_modules/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // The scripts and the tests read workflow files and JSON, which are untyped.
    files: ["scripts/**/*.ts", "test/**/*.ts"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
);
