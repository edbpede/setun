import { defineConfig } from "@playwright/test";

/**
 * Setun runs on two origins (PRD §6): the application, and the artifact sandbox.
 * Both are reserved here so no other process claims them and so the split exists
 * locally from the start; the sandbox origin gets its static server in Phase 4.1,
 * when `sandbox/` is built.
 */
const APP_PORT = Number(process.env.SETUN_E2E_APP_PORT ?? 4173);
export const SANDBOX_PORT = Number(process.env.SETUN_E2E_SANDBOX_PORT ?? 4174);
const GATEWAY_PORT = Number(process.env.SETUN_E2E_GATEWAY_PORT ?? 4175);

export const APP_ORIGIN = `http://localhost:${APP_PORT}`;
export const SANDBOX_ORIGIN = `http://localhost:${SANDBOX_PORT}`;

/**
 * A disposable database per run, so a suite never inherits another's students,
 * conversations or turns. Exported for the seed helper.
 */
export const E2E_DATABASE_PATH = "./test-results/e2e/setun.sqlite";

/**
 * Attachments and generated images, kept beside the disposable database.
 *
 * Outside any web root, as they are in a real deployment — nothing serves this
 * directory, and every read goes through an owner-scoped endpoint (§21).
 */
export const E2E_STORAGE_PATH = "./test-results/e2e/storage";

/** Test-only pepper. Real deployments supply a secret via `.env` (§6.2, §7). */
export const E2E_PEPPER = "e2e-pepper-not-a-real-secret";

/**
 * The operator account, seeded from deployment configuration at boot (§7, §6.2).
 *
 * Test-only values. There is no in-application password recovery, so re-seeding
 * these and restarting is how a real deployment resets the credential — which is
 * exactly what a fresh e2e run does.
 */
export const E2E_EDUCATOR_USERNAME = "e2e-educator";
export const E2E_EDUCATOR_PASSWORD = "e2e-educator-password-not-a-real-secret";

const appEnv = {
  PORT: String(APP_PORT),
  // adapter-node's CSRF origin check compares against this. Unset, the adapter
  // assumes https and rejects every form POST arriving over http — which is
  // what a browser sends here.
  ORIGIN: APP_ORIGIN,
  SETUN_DATABASE_PATH: E2E_DATABASE_PATH,
  SETUN_STORAGE_PATH: E2E_STORAGE_PATH,
  SETUN_STUDENT_CODE_PEPPER: E2E_PEPPER,
  SETUN_CPA_LISTENER_KEY: "e2e-listener-key",
  SETUN_EDUCATOR_SEED_USERNAME: E2E_EDUCATOR_USERNAME,
  SETUN_EDUCATOR_SEED_PASSWORD: E2E_EDUCATOR_PASSWORD,
  // The stub gateway stands in for CPA; everything from the route down is real.
  SETUN_CPA_BASE_URL: `http://127.0.0.1:${GATEWAY_PORT}`,
  SETUN_APP_ORIGIN: APP_ORIGIN,
  SETUN_SANDBOX_ORIGIN: SANDBOX_ORIGIN,
};

export default defineConfig({
  testMatch: "**/*.e2e.ts",
  use: { baseURL: APP_ORIGIN },
  webServer: [
    {
      command: `rm -rf ${E2E_DATABASE_PATH.replace(/\/[^/]+$/, "")} && bun --bun vite build && bun ./build/index.js`,
      port: APP_PORT,
      reuseExistingServer: !process.env.CI,
      env: appEnv,
    },
    {
      command: "bun run e2e/support/stub-gateway-server.ts",
      port: GATEWAY_PORT,
      reuseExistingServer: !process.env.CI,
      env: { SETUN_E2E_GATEWAY_PORT: String(GATEWAY_PORT) },
    },
  ],
});
