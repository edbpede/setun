import { describe, expect, it } from "bun:test";
import { generateLabel } from "./pseudonyms";
import { WORDLISTS, type WordlistLocale } from "./wordlists";

/**
 * Pseudonym generation and uniqueness (plan 1.3, PRD §7, §17, §22).
 */

const LOCALES: WordlistLocale[] = ["en", "da"];

describe("generateLabel", () => {
  it("produces an adjective-noun pair drawn from the requested locale", () => {
    for (const locale of LOCALES) {
      const { adjectives, nouns } = WORDLISTS[locale];
      const [adjective, noun] = generateLabel(locale).split("-");

      expect(adjectives).toContain(adjective);
      expect(nouns).toContain(noun);
    }
  });

  it("never returns a label already taken in the classroom", () => {
    for (const locale of LOCALES) {
      const taken = new Set<string>();
      // Far beyond a classroom, and beyond the random-attempt ceiling, so the
      // deterministic walk is exercised too.
      for (let i = 0; i < 500; i++) {
        const label = generateLabel(locale, taken);
        expect(taken.has(label)).toBe(false);
        taken.add(label);
      }
      expect(taken.size).toBe(500);
    }
  });

  it("still yields a unique label when the whole wordlist is exhausted", () => {
    const { adjectives, nouns } = WORDLISTS.en;
    const taken = new Set<string>();
    for (const adjective of adjectives) {
      for (const noun of nouns) taken.add(`${adjective}-${noun}`);
    }

    const label = generateLabel("en", taken);
    expect(taken.has(label)).toBe(false);
  });
});

describe("wordlists", () => {
  it("ships both pilot locales with entries that are unique and url-safe", () => {
    for (const locale of LOCALES) {
      const { adjectives, nouns } = WORDLISTS[locale];

      expect(new Set(adjectives).size).toBe(adjectives.length);
      expect(new Set(nouns).size).toBe(nouns.length);
      // The label appears in the interface and in the educator roster; a hyphen
      // inside a word would make the pair ambiguous to split.
      for (const word of [...adjectives, ...nouns]) {
        expect(word).not.toContain("-");
        expect(word).toBe(word.toLowerCase());
      }
    }
  });
});
