import { describe, expect, it } from "bun:test";
import {
  artifactSegmentCount,
  artifactSegments,
  streamingMessageSegments,
  streamingSegments,
} from "./segments";

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

describe("streamingSegments", () => {
  it("leaves prose alone when there is no fence in it", () => {
    expect(streamingSegments("Jeg bygger den nu.")).toEqual([
      { kind: "text", text: "Jeg bygger den nu." },
    ]);
  });

  it("collapses the fence still arriving to a pending stub with its identity", () => {
    const segments = streamingSegments(
      ["Her er siden:", '```html id=side title="Min side"', "<!doctype html>", "<h1>Hej"].join(
        "\n",
      ),
    );

    // The pupil watched `<!doctype html>` scroll past before this (§13, §20).
    expect(segments).toEqual([
      { kind: "text", text: "Her er siden:" },
      { kind: "pending", language: "html", key: "side", title: "Min side" },
    ]);
  });

  it("leaves an open fence that is not an artifact in the prose", () => {
    const markdown = "Sådan her:\n```js\nconst x = 1;";

    // An ordinary code block is prose while it streams, exactly as before.
    expect(streamingSegments(markdown)).toEqual([{ kind: "text", text: markdown }]);
  });

  it("names a closed block and goes on to the one still arriving", () => {
    const segments = streamingSegments(
      ["```html id=en\n<p>en</p>\n```", "Og nu den anden:", "```svg id=to", "<svg"].join("\n"),
    );

    expect(segments.map((segment) => segment.kind)).toEqual(["artifact", "text", "pending"]);
    expect(segments[0].kind === "artifact" && segments[0].artifact.key).toBe("en");
    expect(segments[2]).toEqual({ kind: "pending", language: "svg", key: "to", title: null });
  });

  it("does not read a backtick inside an info string as a fence", () => {
    const markdown = "Skriv `html` sådan her.";

    expect(streamingSegments(markdown)).toEqual([{ kind: "text", text: markdown }]);
  });

  it("reads a tilde fence, whose info string may hold a backtick", () => {
    const segments = streamingSegments("~~~html id=side\n<p>hi");

    expect(segments).toEqual([{ kind: "pending", language: "html", key: "side", title: null }]);
  });

  it("scans a long buffer without parsing it", () => {
    const body = Array.from({ length: 500 }, (_, at) => `<p>linje ${at}</p>`).join("\n");
    const segments = streamingSegments(`Her er den:\n\`\`\`html id=lang\n${body}`);

    expect(segments.map((segment) => segment.kind)).toEqual(["text", "pending"]);
  });
});

describe("streamingMessageSegments", () => {
  it("carries an open fence across the tool call that split the prose", () => {
    // `StreamingTurn` starts a new text part wherever a tool call landed between
    // two deltas, and a model can call one in the middle of writing a page.
    const [before, after] = streamingMessageSegments([
      'Her er siden:\n```html id=side title="Min side"\n<h1>Hej',
      "</h1>\n```\nFærdig.",
    ]);

    // Scanned apart, the second part had no opening line and the rest of the
    // pupil's page arrived as prose (§13, §20).
    expect(before).toEqual([
      { kind: "text", text: "Her er siden:" },
      { kind: "pending", language: "html", key: "side", title: "Min side" },
    ]);
    // One artifact is one stub, owned by the part that opened it.
    expect(after).toEqual([{ kind: "text", text: "Færdig." }]);
  });

  it("renders nothing for a part wholly inside a carried fence", () => {
    const scans = streamingMessageSegments([
      "```html id=side\n<h1>Hej",
      "<p>mere</p>",
      "</h1>\n```",
    ]);

    expect(scans[0]).toEqual([{ kind: "pending", language: "html", key: "side", title: null }]);
    expect(scans[1]).toEqual([]);
    expect(scans[2]).toEqual([]);
  });

  it("does not leak the closing fence when a part begins with it", () => {
    const scans = streamingMessageSegments(["```html id=side\n<h1>Hej</h1>", "```\nFærdig."]);

    expect(scans[1]).toEqual([{ kind: "text", text: "Færdig." }]);
  });

  it("scans a part after a closed fence exactly as it would alone", () => {
    const scans = streamingMessageSegments([
      "```html id=en\n<p>en</p>\n```",
      "Og nu:\n```svg id=to\n<svg",
    ]);

    expect(scans[0].map((segment) => segment.kind)).toEqual(["artifact"]);
    expect(scans[1]).toEqual([
      { kind: "text", text: "Og nu:" },
      { kind: "pending", language: "svg", key: "to", title: null },
    ]);
  });

  it("leaves an ordinary code block spanning a boundary as prose on both sides", () => {
    // A js block is prose while it streams, and carrying it would change nothing
    // — so it is not carried, and both parts read as they always did.
    const scans = streamingMessageSegments(["Sådan her:\n```js\nconst x = 1;", "\n```\nFærdig."]);

    expect(scans[0]).toEqual([{ kind: "text", text: "Sådan her:\n```js\nconst x = 1;" }]);
    expect(scans[1].map((segment) => segment.kind)).toEqual(["text"]);
  });

  it("is one scan per text, in the order they were given", () => {
    expect(streamingMessageSegments([])).toEqual([]);
    expect(streamingMessageSegments(["en", "to", "tre"])).toHaveLength(3);
  });
});
