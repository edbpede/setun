import { describe, expect, it } from "bun:test";
import { constantTimeEquals } from "./constant-time";

/**
 * The comparison both first-run secrets go through (plan 6.1, PRD §21, §22).
 *
 * Timing is not asserted here — a wall-clock assertion on a comparison this
 * short is a flake generator, and the property is guaranteed by the primitive
 * rather than by this suite. What is asserted is that the primitive is being
 * *used correctly*: equal values match, unequal ones do not, and a length
 * mismatch returns false rather than throwing, which is what `timingSafeEqual`
 * does on its own and would surface as a 500 on a mistyped token.
 */
describe("constantTimeEquals", () => {
  it("matches identical values", () => {
    expect(constantTimeEquals("ABCD1234", "ABCD1234")).toBe(true);
  });

  it("rejects values differing in the last position", () => {
    expect(constantTimeEquals("ABCD1234", "ABCD1235")).toBe(false);
  });

  it("rejects values differing in the first position", () => {
    expect(constantTimeEquals("ABCD1234", "BBCD1234")).toBe(false);
  });

  it("returns false rather than throwing on a length mismatch", () => {
    expect(constantTimeEquals("ABCD", "ABCDE")).toBe(false);
    expect(constantTimeEquals("", "x")).toBe(false);
  });

  it("compares by bytes, so equal empty values match", () => {
    expect(constantTimeEquals("", "")).toBe(true);
  });

  it("handles non-ASCII without truncating", () => {
    expect(constantTimeEquals("grævling", "grævling")).toBe(true);
    expect(constantTimeEquals("grævling", "gravling")).toBe(false);
  });
});
