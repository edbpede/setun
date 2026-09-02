import { describe, expect, it } from "bun:test";
import {
  effectiveArtifactKey,
  fallbackArtifactKey,
  fenceInfo,
  normaliseArtifactKey,
} from "./identity";

/**
 * The identity a model writes on a fence (PRD §13).
 *
 * The interesting half is what is *rejected*: a key is an identifier the model
 * has to be able to reproduce exactly, so anything that would not survive a
 * round trip through a fence info string is no key at all — and an absent key
 * falls back to the language rule rather than to a guess.
 */

describe("normaliseArtifactKey", () => {
  it("accepts a lowercase slug", () => {
    expect(normaliseArtifactKey("home-page")).toBe("home-page");
    expect(normaliseArtifactKey("quiz_2")).toBe("quiz_2");
    expect(normaliseArtifactKey("a")).toBe("a");
  });

  it("lowercases, so one artifact does not become two", () => {
    expect(normaliseArtifactKey("Home-Page")).toBe("home-page");
    expect(normaliseArtifactKey("  SPIL  ")).toBe("spil");
  });

  it("refuses anything that is not a slug", () => {
    for (const value of ["-leading", "with space", "æble", "a/b", "a.b", "a".repeat(65), ""]) {
      expect(normaliseArtifactKey(value)).toBeNull();
    }
    expect(normaliseArtifactKey(null)).toBeNull();
    expect(normaliseArtifactKey(undefined)).toBeNull();
  });
});

describe("fallbackArtifactKey", () => {
  it("names an artifact whose model wrote no id", () => {
    expect(fallbackArtifactKey({ language: "html", id: "abcdef0123" })).toBe("html-abcdef");
  });

  it("produces a key the pattern itself accepts, so a model may adopt it", () => {
    const key = fallbackArtifactKey({ language: "svelte", id: "0A1B2C3D" });
    expect(normaliseArtifactKey(key)).toBe(key);
  });
});

describe("effectiveArtifactKey", () => {
  it("prefers the stored key", () => {
    expect(effectiveArtifactKey({ language: "html", id: "abcdef", key: "spil" })).toBe("spil");
  });

  it("falls back for a row that has none", () => {
    expect(effectiveArtifactKey({ language: "svg", id: "abcdef", key: null })).toBe("svg-abcdef");
  });
});

describe("fenceInfo", () => {
  it("writes the info string the model is asked to produce", () => {
    expect(fenceInfo("html", { key: "home-page", title: "Min hjemmeside" })).toBe(
      'html id=home-page title="Min hjemmeside"',
    );
  });

  it("omits what it does not have", () => {
    expect(fenceInfo("svg", { key: null, title: null })).toBe("svg");
    expect(fenceInfo("tsx", { key: "spil" })).toBe("tsx id=spil");
  });

  it("strips what would break the fence out of a title", () => {
    const info = fenceInfo("html", { key: "a", title: 'He said "hi"\nand `then`' });

    expect(info).toBe('html id=a title="He said hi and then"');
  });

  it("bounds a title at 120 characters", () => {
    const info = fenceInfo("html", { key: "a", title: "x".repeat(300) });

    expect(info).toBe(`html id=a title="${"x".repeat(120)}"`);
  });
});
