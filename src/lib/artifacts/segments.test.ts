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
    // Mid-line, so no fence is opened at all.
    const inline = "Skriv `html` sådan her.";
    expect(streamingSegments(inline)).toEqual([{ kind: "text", text: inline }]);

    // And the guard itself: a line that *does* open with three backticks, whose
    // info string holds one. CommonMark says that is not a fence — it is how an
    // inline code span written with three backticks stays inline.
    const info = "```html id=`x`\n<p>hi";
    expect(streamingSegments(info)).toEqual([{ kind: "text", text: info }]);

    // A tilde fence's info string may hold one, so the same info string that is
    // not a fence above opens one here.
    expect(streamingSegments("~~~html id=side title=`x`\n<p>hi")).toEqual([
      { kind: "pending", language: "html", key: "side", title: "`x`" },
    ]);
  });

  it("reads a tilde fence, whose info string may hold a backtick", () => {
    const segments = streamingSegments("~~~html id=side title=`x`\n<p>hi");

    // The backtick is what makes this a tilde fence's case: the same info string
    // after three backticks is not a fence at all.
    expect(segments).toEqual([{ kind: "pending", language: "html", key: "side", title: "`x`" }]);
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
      // Named rather than still "being built": the fence closed in the part
      // after the tool call, and the stub stays where it opened.
      {
        kind: "artifact",
        artifact: {
          language: "html",
          source: "<h1>Hej</h1>",
          line: 1,
          endLine: -1,
          key: "side",
          title: "Min side",
        },
      },
    ]);
    // One artifact is one card, owned by the part that opened it.
    expect(after).toEqual([{ kind: "text", text: "Færdig." }]);
  });

  it("renders nothing for a part wholly inside a carried fence", () => {
    const scans = streamingMessageSegments([
      "```html id=side\n<h1>Hej",
      "<p>mere</p>",
      "</h1>\n```",
    ]);

    // The source is the whole file, gathered from every part it crossed.
    expect(scans[0]).toEqual([
      {
        kind: "artifact",
        artifact: {
          language: "html",
          source: "<h1>Hej<p>mere</p></h1>",
          line: 0,
          endLine: -1,
          key: "side",
          title: null,
        },
      },
    ]);
    expect(scans[1]).toEqual([]);
    expect(scans[2]).toEqual([]);
  });

  it("keeps the stub pending while the fence it opened is still open", () => {
    const scans = streamingMessageSegments(["```html id=side\n<h1>Hej", "<p>mere</p>"]);

    expect(scans[0]).toEqual([{ kind: "pending", language: "html", key: "side", title: null }]);
    expect(scans[1]).toEqual([]);
  });

  it("does not read a code block's closing line as an opening one in the next part", () => {
    // The `js` block closes in the second part. Carrying only artifact fences
    // left that ``` reading as an *opening* fence, and the html artifact behind
    // it was parsed as the body of a code block and rendered as prose.
    const scans = streamingMessageSegments([
      "Sådan:\n```js\nconst x = 1;",
      "```\n```html id=side\n<p>hi</p>\n```",
    ]);

    expect(scans[1].map((segment) => segment.kind)).toEqual(["text", "artifact"]);
    expect(scans[1][1].kind === "artifact" && scans[1][1].artifact.key).toBe("side");
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

  it("keeps an empty carried block as the prose it was written as", () => {
    const texts = ["Her er siden:\n```html id=side", "\n```\nFærdig."];
    const scans = streamingMessageSegments(texts);

    // An empty body is not an artifact: `detectArtifacts` skips it and the
    // settled transcript renders the fence as written, so a card here would be
    // the streaming view and the database disagreeing about what was built.
    expect(scans).toEqual([
      [{ kind: "text", text: "Her er siden:\n```html id=side" }],
      [{ kind: "text", text: "\n```\nFærdig." }],
    ]);

    // Which is the same prose a single scan of the whole message gives, split
    // only where the parts are.
    expect(streamingSegments(texts.join(""))).toEqual([
      { kind: "text", text: "Her er siden:\n```html id=side\n```\nFærdig." },
    ]);
  });

  it("keeps a whitespace-only carried block as prose too", () => {
    const scans = streamingMessageSegments(["```html id=side\n   ", "  \n```\nFærdig."]);

    expect(scans[0]).toEqual([{ kind: "text", text: "```html id=side\n   " }]);
    expect(scans[1].map((segment) => segment.kind)).toEqual(["text"]);
  });

  it("remembers a body that arrived in a middle part", () => {
    // Nothing in the part that opened the fence and nothing in the one that
    // closed it: whether there is a body is the answer over every part, not the
    // answer for the last one the scan happened to see.
    const scans = streamingMessageSegments(["```html id=side", "<p>hi</p>", "\n```\nFærdig."]);

    expect(scans[0]).toEqual([
      {
        kind: "artifact",
        artifact: {
          language: "html",
          source: "<p>hi</p>",
          line: 0,
          endLine: -1,
          key: "side",
          title: null,
        },
      },
    ]);
    expect(scans[2]).toEqual([{ kind: "text", text: "Færdig." }]);
  });

  it("is one scan per text, in the order they were given", () => {
    expect(streamingMessageSegments([])).toEqual([]);
    expect(streamingMessageSegments(["en", "to", "tre"])).toHaveLength(3);
  });
});
