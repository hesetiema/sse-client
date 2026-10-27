import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
      reporter: ["text", "lcov"],
      // Floors sit a little under the current numbers (87.9 / 86.5 / 85.0 / 87.9),
      // so they catch a regression without failing every time a branch moves.
      thresholds: {
        statements: 85,
        branches: 83,
        functions: 82,
        lines: 85,
      },
    },
  },
});
