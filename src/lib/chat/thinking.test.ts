import { describe, expect, it } from "bun:test";
import { PLACEHOLDER_INTERVAL_MS, PLACEHOLDER_STATUSES, placeholderIndex } from "./thinking-status";
import { thinkingHeadline, thinkingParagraphs } from "./thinking-text";
import { effectiveThinking, thinkingChoiceAvailable } from "./thinking-visibility";

/**
 * The pure half of showing the model's thinking (PRD §20, §22).
 */

describe("effectiveThinking", () => {
  it("lets the pupil decide where the classroom left it to them", () => {
    expect(effectiveThinking("student", "show")).toBe(true);
    expect(effectiveThinking("student", "hide")).toBe(false);
  });

  it("overrides the pupil where the classroom decided", () => {
    expect(effectiveThinking("shown", "hide")).toBe(true);
    expect(effectiveThinking("hidden", "show")).toBe(false);
  });

  /**
   * A control that cannot change what happens is a promise the interface does
   * not keep.
   */
  it("offers the switch only where it decides something", () => {
    expect(thinkingChoiceAvailable("student")).toBe(true);
    expect(thinkingChoiceAvailable("shown")).toBe(false);
    expect(thinkingChoiceAvailable("hidden")).toBe(false);
  });
});

describe("thinkingParagraphs", () => {
  it("splits on blank lines and drops the blank runs", () => {
    expect(thinkingParagraphs("En\n\n\nTo\n\nTre")).toEqual(["En", "To", "Tre"]);
  });

  it("keeps a single paragraph's own line breaks", () => {
    expect(thinkingParagraphs("En\nlinje mere")).toEqual(["En\nlinje mere"]);
  });

  it("returns nothing for nothing", () => {
    expect(thinkingParagraphs("")).toEqual([]);
    expect(thinkingParagraphs("\n\n  \n")).toEqual([]);
  });
});

describe("thinkingHeadline", () => {
  it("takes the latest paragraph's first line", () => {
    expect(thinkingHeadline("Først dette\n\n**Nu det andet**\nog mere")).toBe("Nu det andet");
  });

  /**
   * The block renders text nodes only, so a provider's markdown emphasis would
   * otherwise show as literal asterisks (§21).
   */
  it("strips the emphasis and list markers a provider adds", () => {
    expect(thinkingHeadline("- *Læser* opgaven")).toBe("Læser opgaven");
    expect(thinkingHeadline("## Overskrift")).toBe("Overskrift");
  });

  it("truncates to something a summary line can hold", () => {
    const headline = thinkingHeadline("x".repeat(200), 20);

    expect(headline).toHaveLength(20);
    expect(headline.endsWith("…")).toBe(true);
  });

  it("has nothing to say about nothing", () => {
    expect(thinkingHeadline("")).toBe("");
  });
});

describe("placeholderIndex", () => {
  it("advances one line per interval", () => {
    expect(placeholderIndex(0)).toBe(0);
    expect(placeholderIndex(PLACEHOLDER_INTERVAL_MS - 1)).toBe(0);
    expect(placeholderIndex(PLACEHOLDER_INTERVAL_MS)).toBe(1);
    expect(placeholderIndex(2 * PLACEHOLDER_INTERVAL_MS)).toBe(2);
  });

  /**
   * Clamped rather than cycling: going back to "Reading your message…" after
   * sixteen seconds tells the pupil the model started over.
   */
  it("stops on the last line rather than starting again", () => {
    const last = PLACEHOLDER_STATUSES.length - 1;

    expect(placeholderIndex(10 * PLACEHOLDER_INTERVAL_MS)).toBe(last);
    expect(placeholderIndex(Number.MAX_SAFE_INTEGER)).toBe(last);
  });

  it("treats a clock that ran backwards as no time at all", () => {
    expect(placeholderIndex(-5_000)).toBe(0);
  });
});
