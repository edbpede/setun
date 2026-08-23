import { describe, expect, it } from "bun:test";

describe("bun test harness", () => {
  it("runs the setup file preloaded from bunfig.toml before any suite", () => {
    // Deliberately imports nothing from the setup module: the marker can only be
    // present if `[test] preload` ran it first. Importing it here would make the
    // assertion pass even with the preload misconfigured.
    expect((globalThis as Record<string, unknown>).__SETUN_TEST_SETUP__).toBe(
      "setun:bun-test-setup",
    );
  });
});
