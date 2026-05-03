import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["agent/tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["agent/src/**/*.ts"],
    },
  },
});
