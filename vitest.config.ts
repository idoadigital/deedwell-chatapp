import { defineConfig } from "vitest/config";
import path from "node:path";

const pkg = (name: string) =>
  path.resolve(__dirname, `packages/${name}/src/index.ts`);

export default defineConfig({
  resolve: {
    alias: {
      "@deedwell/schemas": pkg("schemas"),
      "@deedwell/auth": pkg("auth"),
      "@deedwell/database": pkg("database"),
      "@deedwell/agent-runtime": pkg("agent-runtime"),
      "@deedwell/tools": pkg("tools"),
      "@deedwell/workflows": pkg("workflows"),
      "@deedwell/grant-domain": pkg("grant-domain"),
      "@deedwell/website-domain": pkg("website-domain"),
      "@deedwell/adgrants-domain": pkg("adgrants-domain"),
      "@deedwell/browser-automation": pkg("browser-automation"),
      "@deedwell/billing-domain": pkg("billing-domain"),
      "@deedwell/observability": pkg("observability"),
    },
  },
  test: {
    include: [
      "packages/**/*.test.ts",
      "tests/**/*.test.ts",
      "apps/desktop/src/**/*.test.ts",
      "apps/api/src/**/*.test.ts",
    ],
    setupFiles: ["tests/setup-env.ts"],
    // Integration/security tests share one Postgres database; run files serially.
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
