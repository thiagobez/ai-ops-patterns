import { defineConfig } from "vitest/config";

// One vitest run for the whole monorepo. Tests use in-memory adapters only:
// no network, no database, no API key.
export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    environment: "node",
  },
});
