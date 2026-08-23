import { describe, expect, it } from "bun:test";
import {
  CODE_LENGTH,
  digestCode,
  formatCodeForDisplay,
  generateCode,
  isPlausibleCode,
  normaliseCode,
} from "./codes";

/**
 * Access-code generation, encoding and digesting (plan 1.3, PRD §7, §22).
 */

const PEPPER = "test-pepper-not-a-real-secret";

describe("generateCode", () => {
  it("produces a 24-symbol Crockford code, which is 120 bits of entropy", () => {
    const code = generateCode();

    expect(code.normalised).toHaveLength(CODE_LENGTH);
    // 24 symbols x 5 bits = 120 bits, the PRD §7 floor.
    expect(code.normalised.length * 5).toBeGreaterThanOrEqual(120);
  });

  it("uses only Crockford symbols, excluding the ambiguous I, L, O and U", () => {
    for (let i = 0; i < 200; i++) {
      expect(generateCode().normalised).toMatch(/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]+$/);
    }
  });

  it("does not repeat across many draws", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1_000; i++) seen.add(generateCode().normalised);

    expect(seen.size).toBe(1_000);
  });

  it("exposes a hint that is a strict, short suffix of the code", () => {
    const code = generateCode();

    expect(code.hint).toHaveLength(4);
    expect(code.normalised.endsWith(code.hint)).toBe(true);
    // The hint identifies a card; it must not come close to reconstructing one.
    expect(code.hint.length).toBeLessThan(code.normalised.length / 4);
  });

  it("groups the display form without changing the code", () => {
    const code = generateCode();

    expect(code.display).toBe(formatCodeForDisplay(code.normalised));
    expect(normaliseCode(code.display)).toBe(code.normalised);
  });
});

describe("normaliseCode", () => {
  it("accepts the grouped display form, spaces and lower case", () => {
    expect(normaliseCode("abcd-efgh")).toBe("ABCDEFGH");
    expect(normaliseCode("abcd efgh")).toBe("ABCDEFGH");
  });

  it("applies the Crockford aliases so O reads as 0 and I and L read as 1", () => {
    expect(normaliseCode("OIL")).toBe("011");
  });

  it("is idempotent", () => {
    const once = normaliseCode("abcd-efgh");
    expect(normaliseCode(once)).toBe(once);
  });
});

describe("isPlausibleCode", () => {
  it("rejects wrong lengths and non-alphabet symbols", () => {
    expect(isPlausibleCode("TOOSHORT")).toBe(false);
    expect(isPlausibleCode("U".repeat(CODE_LENGTH))).toBe(false);
    expect(isPlausibleCode(generateCode().normalised)).toBe(true);
  });
});

describe("digestCode", () => {
  it("is deterministic and hex encoded", async () => {
    const code = generateCode();
    const first = await digestCode(code.normalised, PEPPER);

    expect(await digestCode(code.normalised, PEPPER)).toBe(first);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  it("never contains the plaintext code", async () => {
    const code = generateCode();
    const digest = await digestCode(code.normalised, PEPPER);

    expect(digest).not.toContain(code.normalised);
    expect(digest.toUpperCase()).not.toContain(code.normalised);
  });

  it("digests the grouped and normalised forms identically", async () => {
    const code = generateCode();

    expect(await digestCode(code.display, PEPPER)).toBe(await digestCode(code.normalised, PEPPER));
  });

  it("is unique per code", async () => {
    const digests = new Set<string>();
    for (let i = 0; i < 200; i++) {
      digests.add(await digestCode(generateCode().normalised, PEPPER));
    }

    expect(digests.size).toBe(200);
  });

  it("changes completely when the pepper changes", async () => {
    const code = generateCode();

    expect(await digestCode(code.normalised, PEPPER)).not.toBe(
      await digestCode(code.normalised, "a-different-pepper"),
    );
  });
});
