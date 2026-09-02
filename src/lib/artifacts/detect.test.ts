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

  it("reports the closing fence, so a whole block can be replaced by line", () => {
    const blocks = fencedBlocks("intro\n```html\na\nb\n```\nafter");

    expect(blocks[0].line).toBe(1);
    expect(blocks[0].endLine).toBe(4);
  });

  it("reads key=value pairs past the language, in either quote style or bare", () => {
    const blocks = fencedBlocks(
      `\`\`\`html id=home-page title="Min hjemmeside" note='kort' bare=x\nb\n\`\`\``,
    );

    expect(blocks[0].attributes).toEqual({
      id: "home-page",
      title: "Min hjemmeside",
      note: "kort",
      bare: "x",
    });
  });

  it("takes the first of a repeated key", () => {
    const blocks = fencedBlocks("~~~html id=first id=second\nb\n~~~");

    expect(blocks[0].attributes.id).toBe("first");
  });

  it("has no attributes when the info string is only a language", () => {
    expect(fencedBlocks("```html\na\n```")[0].attributes).toEqual({});
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

  it("carries the identity the model wrote on the fence", () => {
    const [found] = detectArtifacts('```html id=Home-Page title="Min side"\n<p>hi</p>\n```');

    expect(found.key).toBe("home-page");
    expect(found.title).toBe("Min side");
    expect(found.endLine).toBe(2);
  });

  it("treats an id that is not a slug as no id at all", () => {
    expect(detectArtifacts("```html id=min/side\n<p>hi</p>\n```")[0].key).toBeNull();
    expect(detectArtifacts('```html id="min side"\n<p>hi</p>\n```')[0].key).toBeNull();
    expect(detectArtifacts("```html\n<p>hi</p>\n```")[0].key).toBeNull();
  });

  it("skips an empty artifact block", () => {
    expect(detectArtifacts("```html\n\n```")).toEqual([]);
  });

  it("finds nothing in prose without fences", () => {
    expect(detectArtifacts("Jeg forklarer loops uden kode.")).toEqual([]);
  });
});

describe("continuityDecision", () => {
  const page = {
    id: "a1",
    language: "html" as const,
    key: "home-page",
    updatedAt: 10,
    createdAt: 1,
  };
  const logo = { id: "a2", language: "svg" as const, key: null, updatedAt: 20, createdAt: 2 };

  it("starts a new artifact when the conversation has none", () => {
    expect(continuityDecision({ language: "html", key: null, existing: [] })).toEqual({
      kind: "new",
      key: null,
    });
  });

  it("versions the artifact whose key matches", () => {
    expect(
      continuityDecision({ language: "html", key: "home-page", existing: [page, logo] }),
    ).toEqual({ kind: "version", artifactId: "a1" });
  });

  it("keeps the key across a language change: a rewrite is still one thing", () => {
    expect(continuityDecision({ language: "svelte", key: "home-page", existing: [page] })).toEqual({
      kind: "version",
      artifactId: "a1",
    });
  });

  it("resolves a fallback key a model adopted from the state note", () => {
    expect(continuityDecision({ language: "svg", key: "svg-a2", existing: [logo] })).toEqual({
      kind: "version",
      artifactId: "a2",
    });
  });

  it("starts a new artifact under a key that matches nothing", () => {
    expect(continuityDecision({ language: "html", key: "quiz", existing: [page] })).toEqual({
      kind: "new",
      key: "quiz",
    });
  });

  it("falls back to the most recent artifact of the same language", () => {
    const older = { id: "a3", language: "html" as const, key: null, updatedAt: 5, createdAt: 3 };

    expect(
      continuityDecision({ language: "html", key: null, existing: [older, page, logo] }),
    ).toEqual({ kind: "version", artifactId: "a1" });
  });

  it("breaks a same-millisecond tie by creation time rather than by row order", () => {
    // Two artifacts rewritten in one message share `updatedAt` to the
    // millisecond, and a stable sort would otherwise hold whatever order the
    // rows arrived in — a different anchor for the same facts (§13).
    const first = { id: "a4", language: "html" as const, key: null, updatedAt: 30, createdAt: 1 };
    const second = { id: "a5", language: "html" as const, key: null, updatedAt: 30, createdAt: 2 };

    for (const existing of [
      [first, second],
      [second, first],
    ]) {
      expect(continuityDecision({ language: "html", key: null, existing })).toEqual({
        kind: "version",
        artifactId: "a5",
      });
    }
  });

  it("does not let another language steal the anchor", () => {
    // The observed failure: an interleaved svg is the conversation's most recent
    // artifact, and the next html block forked a row of its own because of it.
    expect(continuityDecision({ language: "html", key: null, existing: [logo] })).toEqual({
      kind: "new",
      key: null,
    });
  });
});
