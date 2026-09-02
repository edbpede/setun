import { describe, expect, it } from "bun:test";
import { artifactSegmentCount, artifactSegments } from "./segments";

describe("artifactSegments", () => {
  it("splits prose around an artifact block", () => {
    const segments = artifactSegments(
      ["Her er siden:", "```html id=side", "<p>hi</p>", "```", "Prøv den."].join("\n"),
    );

    expect(segments.map((segment) => segment.kind)).toEqual(["text", "artifact", "text"]);
    expect(segments[0]).toEqual({ kind: "text", text: "Her er siden:" });
    expect(segments[2]).toEqual({ kind: "text", text: "Prøv den." });
  });

  it("carries the block as written, for a caller that cannot place it", () => {
    const [segment] = artifactSegments("```html id=side\n<p>hi</p>\n```");

    expect(segment.kind).toBe("artifact");
    if (segment.kind !== "artifact") throw new Error("expected an artifact segment");
    expect(segment.raw).toBe("```html id=side\n<p>hi</p>\n```");
    expect(segment.artifact.key).toBe("side");
    expect(segment.index).toBe(0);
  });

  it("numbers from the running count so a message's parts agree", () => {
    const segments = artifactSegments("```svg\n<svg/>\n```", 2);

    expect(segments[0].kind === "artifact" && segments[0].index).toBe(2);
  });

  it("numbers two blocks in one part in order", () => {
    const segments = artifactSegments("```html\na\n```\nmid\n```svg\n<svg/>\n```");
    const indices = segments.flatMap((segment) =>
      segment.kind === "artifact" ? [segment.index] : [],
    );

    expect(indices).toEqual([0, 1]);
  });

  it("leaves an ordinary code block inside the prose", () => {
    const segments = artifactSegments("```js\nconst x = 1;\n```");

    expect(segments).toEqual([{ kind: "text", text: "```js\nconst x = 1;\n```" }]);
  });

  it("skips an empty artifact block exactly as detection does", () => {
    const segments = artifactSegments("```html\n\n```");

    expect(segments.every((segment) => segment.kind === "text")).toBe(true);
  });

  it("emits no text segment for blank space between blocks", () => {
    const segments = artifactSegments("```html\na\n```\n\n```svg\n<svg/>\n```");

    expect(segments.map((segment) => segment.kind)).toEqual(["artifact", "artifact"]);
  });

  it("returns nothing for empty prose", () => {
    expect(artifactSegments("")).toEqual([]);
    expect(artifactSegments("   \n  ")).toEqual([]);
  });
});

describe("artifactSegmentCount", () => {
  it("counts what a part contributes to the running index", () => {
    expect(artifactSegmentCount("```html\na\n```\n```js\nb\n```")).toBe(1);
    expect(artifactSegmentCount("ingen kode her")).toBe(0);
  });
});
