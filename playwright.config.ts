// E2E config — the board is always host-backed, so the suite boots a real
// Elan host (state-replace enabled for seeding/reset) AND the Vite UI pointed
// at it via VITE_ELAN_HOST. The rostered harnesses in the fixture are all
// `mock`, so tagging drives the credential-free mock agent — no real CLI.
// Tests share one host process, so run serially (workers: 1) to keep the
// board reset in each beforeEach from racing another test. Run with:
//   bun run e2e
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  timeout: 30_000,
  workers: 1,
  use: {
    baseURL: "http://localhost:5177",
  },
  webServer: [
    {
      command:
        "ELAN_HOST_PORT=4529 ELAN_STATE_DIR=.elan-e2e ELAN_ALLOW_STATE_REPLACE=1 bun dev/elan-host.ts",
      url: "http://127.0.0.1:4529/api/state",
      reuseExistingServer: !process.env.CI,
      stdout: "ignore",
    },
    {
      command: "VITE_ELAN_HOST=http://127.0.0.1:4529 bun run dev -- --port 5177 --strictPort",
      url: "http://localhost:5177",
      reuseExistingServer: !process.env.CI,
      stdout: "ignore",
    },
  ],
});
