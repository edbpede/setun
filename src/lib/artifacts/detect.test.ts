import { describe, expect, it } from "bun:test";
import { continuityDecision } from "./continuity";
import { artifactLanguage, detectArtifacts } from "./detect";
import { fencedBlocks } from "./fences";
import { tierOf } from "./types";

/**
 * The detection matrix and the continuity heuristic (PRD §13, plan 4.2).
 *
 * §13 names the recognised set exactly and then names what must *not* be
 * recognised: "Every other tag — including bare `js`, `ts`, and `css` — remains
 * an ordinary highlighted code block." Both halves are asserted, because the
 * expensive mistake is the second one: rendering somebody's plain snippet in an
 * iframe because a tag looked close enough.
 */

describe("artifactLanguage", () => {
  it("recognises the five artifact tags", () => {
    expect(artifactLanguage("html")).toBe("html");
    expect(artifactLanguage("svg")).toBe("svg");
    expect(artifactLanguage("jsx")).toBe("jsx");
    expect(artifactLanguage("tsx")).toBe("tsx");
    expect(artifactLanguage("svelte")).toBe("svelte");
  });

  it("normalises case and surrounding space", () => {
    expect(artifactLanguage("  HTML ")).toBe("html");
    expect(artifactLanguage("TSX")).toBe("tsx");
  });

  it("leaves every other tag a code block", () => {
    for (const tag of ["js", "ts", "css", "python", "json", "bash", "htm", "vue", "xml", ""]) {
      expect(artifactLanguage(tag)).toBeNull();
    }
    expect(artifactLanguage(null)).toBeNull();
    expect(artifactLanguage(undefined)).toBeNull();
  });
});

describe("tierOf", () => {
  it("puts markup in Tier 0 and components in Tier 1", () => {
    expect(tierOf("html")).toBe(0);
    expect(tierOf("svg")).toBe(0);
    expect(tierOf("jsx")).toBe(1);
    expect(tierOf("tsx")).toBe(1);
    expect(tierOf("svelte")).toBe(1);
  });
});

describe("fencedBlocks", () => {
  it("reads a closed block with its language", () => {
    const blocks = fencedBlocks("before\n```html\n<p>hi</p>\n```\nafter");

    expect(blocks).toHaveLength(1);
    expect(blocks[0].language).toBe("html");
    expect(blocks[0].source).toBe("<p>hi</p>");
  });

  it("ignores a fence that never closes", () => {
    expect(fencedBlocks("```html\n<p>still typing")).toEqual([]);
  });

  it("keeps a shorter inner fence inside a longer outer one", () => {
    const blocks = fencedBlocks("````md\n```html\n<p>hi</p>\n```\n````");

    expect(blocks).toHaveLength(1);
    expect(blocks[0].language).toBe("md");
    expect(blocks[0].source).toBe("```html\n<p>hi</p>\n```");
  });

  it("reads tilde fences", () => {
    const blocks = fencedBlocks("~~~svg\n<svg/>\n~~~");

    expect(blocks[0].language).toBe("svg");
    expect(blocks[0].source).toBe("<svg/>");
  });

  it("does not open a block on inline code", () => {
    expect(fencedBlocks("use `` `html` `` for markup")).toEqual([]);
  });

  it("reads several blocks in order", () => {
    const blocks = fencedBlocks("```html\na\n```\ntext\n```css\nb\n```");

    expect(blocks.map((block) => block.language)).toEqual(["html", "css"]);
    expect(blocks[0].line).toBeLessThan(blocks[1].line);
  });
});

describe("detectArtifacts", () => {
  it("takes the artifact blocks and leaves the rest", () => {
    const prose = [
      "Here is the page:",
      "```html",
      "<button>Klik</button>",
      "```",
      "and the helper:",
      "```js",
      "const x = 1;",
      "```",
    ].join("\n");

    const found = detectArtifacts(prose);

    expect(found).toHaveLength(1);
    expect(found[0].language).toBe("html");
    expect(found[0].source).toBe("<button>Klik</button>");
  });

  it("skips an empty artifact block", () => {
    expect(detectArtifacts("```html\n\n```")).toEqual([]);
  });

  it("finds nothing in prose without fences", () => {
    expect(detectArtifacts("Jeg forklarer loops uden kode.")).toEqual([]);
  });
});

describe("continuityDecision", () => {
  it("starts a new artifact when the conversation has none", () => {
    expect(continuityDecision({ language: "html", latest: null })).toEqual({ kind: "new" });
  });

  it("versions the most recent artifact when the language matches", () => {
    expect(
      continuityDecision({ language: "html", latest: { id: "a1", language: "html" } }),
    ).toEqual({ kind: "version", artifactId: "a1" });
  });

  it("starts a new artifact when the language differs", () => {
    expect(continuityDecision({ language: "tsx", latest: { id: "a1", language: "jsx" } })).toEqual({
      kind: "new",
    });
  });
});
