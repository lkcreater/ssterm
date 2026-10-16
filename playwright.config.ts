import { defineConfig } from "@playwright/test";

const evidence = process.env.SSTERM_PACKAGED_EXECUTABLE
  ? "packaged"
  : "development";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [
    ["list"],
    ["json", { outputFile: `artifacts/test-results/${evidence}.json` }],
  ],
  outputDir: `artifacts/test-results/${evidence}`,
  use: { trace: "retain-on-failure" },
  webServer: process.env.SSTERM_PACKAGED_EXECUTABLE
    ? undefined
    : {
        command: "npm run dev:renderer -- --port 5174",
        url: "http://127.0.0.1:5174",
        reuseExistingServer: false,
        timeout: 30_000,
      },
  projects: process.env.SSTERM_PACKAGED_EXECUTABLE
    ? [
        {
          name: "packaged",
          testMatch: [
            "desktop.spec.ts",
            "storage.spec.ts",
            "secrets.spec.ts",
            "catalog.spec.ts",
            "sessions.spec.ts",
            "known-hosts.spec.ts",
            "auth.spec.ts",
            "credentials.spec.ts",
            "terminal.spec.ts",
            "terminal-input.spec.ts",
            "terminal-flow.spec.ts",
          ],
        },
      ]
    : [
        {
          name: "desktop",
          testMatch: [
            "desktop.spec.ts",
            "storage.spec.ts",
            "secrets.spec.ts",
            "catalog.spec.ts",
            "sessions.spec.ts",
            "known-hosts.spec.ts",
            "auth.spec.ts",
            "credentials.spec.ts",
            "terminal.spec.ts",
            "terminal-input.spec.ts",
            "terminal-flow.spec.ts",
          ],
        },
        { name: "showcase", testMatch: "showcase.spec.ts" },
      ],
});
