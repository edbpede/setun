import { defineConfig } from "@playwright/test";

/**
 * Setun runs on two origins (PRD §6): the application, and the artifact sandbox.
 * Both are served here, by two independent servers: the application by the
 * adapter-node build, and the sandbox by the prebuilt static files Caddy serves
 * in a real deployment. Sharing one server would mean one origin, and origin
 * separation is the entire artifact isolation mechanism (§14).
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
  /**
   * One worker, because the suites are not independent of each other.
   *
   * Playwright runs test *files* in parallel by default, but every suite here
   * shares one application server, one SQLite file, and the global state inside
   * it: the per-IP login window (every worker is loopback, Appendix A caps one
   * address at 30 attempts per 15 minutes) and the model aliases the seed helper
   * creates. A suite's `beforeEach` can clear the login window for itself, but
   * it cannot stop a suite running beside it from filling the window up again
   * before the sign-in that needed it — which surfaces as a login that silently
   * stays on /login, a duplicate alias insert, or a request answered 403.
   *
   * The classrooms are already separated per suite (`SETUN_E2E_CLASSROOM`).
   * What is left is global by nature, so the suites are serialised rather than
   * given a limiter that is weaker under test than in production.
   */
  workers: 1,
  use: { baseURL: APP_ORIGIN },
  webServer: [
    {
      command: `rm -rf ${E2E_DATABASE_PATH.replace(/\/[^/]+$/, "")} && bun --bun vite build && bun ./build/index.js`,
      port: APP_PORT,
      reuseExistingServer: !process.env.CI,
      env: appEnv,
    },
    {
      // The artifact host, built and served exactly as Caddy serves it — the
      // same content security policy included, because that policy is what the
      // escape suite is testing (§14, §22).
      command: "bun run build:sandbox && bun --bun vite preview --config sandbox/vite.config.ts",
      port: SANDBOX_PORT,
      reuseExistingServer: !process.env.CI,
      env: { SETUN_SANDBOX_PORT: String(SANDBOX_PORT) },
    },
    {
      command: "bun run e2e/support/stub-gateway-server.ts",
      port: GATEWAY_PORT,
      reuseExistingServer: !process.env.CI,
      env: { SETUN_E2E_GATEWAY_PORT: String(GATEWAY_PORT) },
    },
  ],
});
