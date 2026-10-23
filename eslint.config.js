import js from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", "**/*.tgz"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Build scripts run in Node and use Node globals.
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      globals: {
        console: "readonly",
        process: "readonly",
      },
    },
  },
  // Must stay last.
  eslintConfigPrettier,
);
