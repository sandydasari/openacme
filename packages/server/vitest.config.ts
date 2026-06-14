import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // Generous: some tests import a template that spawns a real MCP server
    // (npx) and round-trips a sandboxed tool-host worker — both slow on a
    // cold CI runner.
    testTimeout: 60000,
    hookTimeout: 30000,
  },
});
