import { describe, expect, it } from "bun:test";
import {
  BOOTSTRAP_TOKEN_LENGTH,
  BOOTSTRAP_TOKEN_TTL_MS,
  BootstrapTokenHolder,
  bootstrapBanner,
} from "./bootstrap";

/**
 * The first-run bootstrap token (plan 6.1, PRD §6.2, §7, §21, §22).
 *
 * The properties that matter are the ones a wrong implementation would quietly
 * lose: enough entropy, a format an operator can retype off a console, an expiry
 * that is evaluated when asked rather than by a timer, and a holder with no
 * global state to leak between tests.
 */

const CROCKFORD = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]+$/;

describe("BootstrapTokenHolder.mint", () => {
  it("produces a 24-symbol Crockford token — 120 bits, twice the §7 floor", () => {
    const token = new BootstrapTokenHolder().mint();

    expect(token.normalised).toHaveLength(BOOTSTRAP_TOKEN_LENGTH);
    expect(token.normalised).toMatch(CROCKFORD);
    expect(token.normalised.length * 5).toBe(120);
  });

  it("does not repeat across many draws", () => {
    const holder = new BootstrapTokenHolder();
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) seen.add(holder.mint().normalised);

    expect(seen.size).toBe(500);
  });

  it("groups the display form without changing the token", () => {
    const token = new BootstrapTokenHolder().mint();

    expect(token.display.replaceAll("-", "")).toBe(token.normalised);
  });

  it("expires fifteen minutes after minting", () => {
    const now = new Date("2026-09-01T08:00:00Z");
    const token = new BootstrapTokenHolder().mint(now);

    expect(token.expiresAt.getTime() - now.getTime()).toBe(BOOTSTRAP_TOKEN_TTL_MS);
  });

  it("replaces its predecessor, so a restart invalidates the old token", () => {
    const holder = new BootstrapTokenHolder();
    const first = holder.mint();
    const second = holder.mint();

    expect(holder.verify(second.display)).toBe(true);
    expect(holder.verify(first.display)).toBe(false);
  });
});

describe("BootstrapTokenHolder.verify", () => {
  it("accepts the token as printed, hyphens and all", () => {
    const holder = new BootstrapTokenHolder();
    const token = holder.mint();

    expect(holder.verify(token.display)).toBe(true);
    expect(holder.verify(token.normalised)).toBe(true);
  });

  it("accepts the typos retyping off a console produces", () => {
    const holder = new BootstrapTokenHolder();
    const token = holder.mint();

    // Lower case, spaces for hyphens, and Crockford's O/I/L aliases read back
    // as the digits they resemble.
    const mistyped = token.normalised
      .toLowerCase()
      .replaceAll("0", "o")
      .replaceAll("1", "l")
      .replace(/(.{4})/g, "$1 ")
      .trim();

    expect(holder.verify(mistyped)).toBe(true);
  });

  it("refuses an empty, malformed or wrong submission alike", () => {
    const holder = new BootstrapTokenHolder();
    holder.mint();

    expect(holder.verify("")).toBe(false);
    expect(holder.verify("not-a-token")).toBe(false);
    // Right length and alphabet, wrong value.
    expect(holder.verify("2".repeat(BOOTSTRAP_TOKEN_LENGTH))).toBe(false);
    // A huge field is refused by the length pre-filter, not by comparing it.
    expect(holder.verify("A".repeat(100_000))).toBe(false);
  });

  it("refuses everything before a token is minted", () => {
    expect(new BootstrapTokenHolder().verify("ANYTHING")).toBe(false);
  });
});

describe("BootstrapTokenHolder.current", () => {
  it("expires lazily, on the next question rather than on a timer", () => {
    const holder = new BootstrapTokenHolder();
    const now = new Date("2026-09-01T08:00:00Z");
    const token = holder.mint(now);

    const almost = new Date(now.getTime() + BOOTSTRAP_TOKEN_TTL_MS - 1);
    expect(holder.current(almost)).not.toBeNull();
    expect(holder.verify(token.display, almost)).toBe(true);

    const after = new Date(now.getTime() + BOOTSTRAP_TOKEN_TTL_MS);
    expect(holder.current(after)).toBeNull();
    expect(holder.verify(token.display, after)).toBe(false);
  });

  it("forgets the token once it has lapsed, so a later question cannot revive it", () => {
    const holder = new BootstrapTokenHolder();
    const now = new Date("2026-09-01T08:00:00Z");
    holder.mint(now);

    expect(holder.current(new Date(now.getTime() + BOOTSTRAP_TOKEN_TTL_MS))).toBeNull();
    expect(holder.current(now)).toBeNull();
  });

  it("is empty after clear — completion, and process exit", () => {
    const holder = new BootstrapTokenHolder();
    const token = holder.mint();
    holder.clear();

    expect(holder.current()).toBeNull();
    expect(holder.verify(token.display)).toBe(false);
  });

  it("keeps no state between holders, so nothing leaks between tests", () => {
    const first = new BootstrapTokenHolder();
    const token = first.mint();

    expect(new BootstrapTokenHolder().verify(token.display)).toBe(false);
  });
});

describe("bootstrapBanner", () => {
  it("carries the token, the URL to open and the expiry warning", () => {
    const token = new BootstrapTokenHolder().mint();
    const banner = bootstrapBanner({ token, appOrigin: "https://setun.example.org" });

    expect(banner).toContain(token.display);
    expect(banner).toContain("https://setun.example.org/setup");
    expect(banner).toContain("15 minutes");
    expect(banner).toContain("Restarting");
  });
});
