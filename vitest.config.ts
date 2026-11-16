import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@ikigai/core": resolve(__dirname, "packages/core/src/index.ts"),
      "@ikigai/adapters": resolve(__dirname, "packages/adapters/src/index.ts"),
      "@ikigai/cli": resolve(__dirname, "packages/cli/src/index.ts"),
      "@ikigai/github-action": resolve(__dirname, "packages/github-action/src/index.ts"),
    },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts"],
  },
});
