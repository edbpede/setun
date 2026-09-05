import { describe, expect, it } from "bun:test";
import { thinkingHeadline, thinkingParagraphHeadline, thinkingParagraphs } from "./thinking-text";

describe("thinking text", () => {
  it("splits CRLF and whitespace-only separator lines", () => {
    const text = "First\r\n \t\r\nSecond\n\t\nThird";
    expect(thinkingParagraphs(text)).toEqual(["First", "Second", "Third"]);
    expect(thinkingHeadline(text)).toBe("Third");
  });

  it("preserves literal operators, language names and identifiers", () => {
    for (const text of [
      "C# and snake_case",
      "a * b + c",
      "-1 is negative",
      "a_b_c",
      "x ** 2",
      "snake__field__name",
      "a ** b ** c",
    ]) {
      expect(thinkingHeadline(text)).toBe(text);
    }
    expect(thinkingHeadline("Use `*literal*` and `__literal__`")).toBe(
      "Use *literal* and __literal__",
    );
  });

  it("strips paired decoration and leading heading or list markers", () => {
    expect(thinkingHeadline("## **Read** `snake_case` and *think* about _C#_")).toBe(
      "Read snake_case and think about C#",
    );
    expect(thinkingHeadline("- __Read the task__")).toBe("Read the task");
  });

  it("reads the already split last paragraph without parsing the summary again", () => {
    const paragraphs = thinkingParagraphs("Earlier\n\n**Latest step**\nDetails");
    expect(thinkingParagraphHeadline(paragraphs.at(-1) ?? "")).toBe("Latest step");
    expect(thinkingParagraphHeadline("A long headline", 6)).toBe("A lon…");
  });
});
