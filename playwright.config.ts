import { defineConfig } from "@playwright/test";

/**
 * Setun runs on two origins (PRD §6): the application, and the artifact sandbox.
 * Both are reserved here so no other process claims them and so the split exists
 * locally from the start; the sandbox origin gets its static server in Phase 4.1,
 * when `sandbox/` is built.
 */
const APP_PORT = Number(process.env.SETUN_E2E_APP_PORT ?? 4173);
export const SANDBOX_PORT = Number(process.env.SETUN_E2E_SANDBOX_PORT ?? 4174);

export const APP_ORIGIN = `http://localhost:${APP_PORT}`;
export const SANDBOX_ORIGIN = `http://localhost:${SANDBOX_PORT}`;

export default defineConfig({
  testMatch: "**/*.e2e.ts",
  use: { baseURL: APP_ORIGIN },
  webServer: [
    {
      command: "bun --bun vite build && bun ./build/index.js",
      port: APP_PORT,
      reuseExistingServer: !process.env.CI,
      env: { PORT: String(APP_PORT) },
    },
  ],
});
