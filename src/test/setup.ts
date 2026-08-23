/**
 * Preloaded by `bun test` through `[test] preload` in `bunfig.toml`.
 *
 * Server-domain fixtures (in-memory database, deterministic clock) are registered
 * here as the phases that need them land.
 */

export const SETUP_MARKER = "setun:bun-test-setup";

(globalThis as Record<string, unknown>).__SETUN_TEST_SETUP__ = SETUP_MARKER;
