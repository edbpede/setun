import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { E2E_DATABASE_PATH } from "../../playwright.config";

const run = promisify(execFile);

/**
 * Clear the per-IP login window before a suite signs anybody in.
 *
 * Appendix A caps a single IP at 30 login attempts per 15 minutes, and a full
 * end-to-end run signs pupils in far more often than that — from one address,
 * because every worker is loopback. Without this the suites start failing each
 * other's logins in whatever order the workers happen to interleave, which looks
 * like a flaky application and is actually the rate limiter working.
 *
 * This resets test state; it does not weaken the limiter. Its behaviour is
 * asserted where it can be asserted properly, in `bun test`, with a clock the
 * test controls (§7, §22).
 */
export async function clearLoginWindow(): Promise<void> {
  await run("bun", ["run", "e2e/support/reset-login-attempts.ts"], {
    env: { ...process.env, SETUN_DATABASE_PATH: E2E_DATABASE_PATH },
  });
}
