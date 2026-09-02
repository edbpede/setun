import { artifactLanguage, type DetectedArtifact, detectArtifacts } from "./detect";
import { CARRIED, type OpenFence, type ScannedFences, scanFences } from "./fences";
import { normaliseArtifactKey } from "./identity";
import type { ArtifactLanguage } from "./types";

/**
 * A settled message split into prose and the artifacts inside it (PRD §13, §20).
 *
 * The transcript used to render an artifact block as a code block: a wall of
 * markup between two sentences, which is what a fenced block means to `marked`
 * and not what it means here. An artifact is a live document with a panel of its
 * own, so in the transcript it should be a card that opens it.
 *
 * The split is by line, over the same `detectArtifacts` the server records with,
 * so the transcript and the database cannot disagree about which blocks were
 * artifacts. Blocks it skips — an unrecognised tag, an empty body — stay inside
 * the prose and render as ordinary markdown, unchanged.
 */

export type ArtifactSegment =
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "artifact";
      /**
       * Position among the message's artifacts, counting from `firstIndex`.
       *
       * A message's text arrives as several parts, and the artifact refs the
       * server hands back are numbered across the whole message — so the caller
       * carries the running count between parts rather than each part starting
       * at zero.
       */
      readonly index: number;
      readonly artifact: DetectedArtifact;
      /** The block as written, fences included, for the fallback rendering. */
      readonly raw: string;
    };

/**
 * Split one text part. `firstIndex` is how many artifacts earlier parts held.
 *
 * Text segments are emitted only when they hold something other than blank
 * lines: the gap between a paragraph and the block below it is not a paragraph.
 */
export function artifactSegments(markdown: string, firstIndex = 0): ArtifactSegment[] {
  const found = detectArtifacts(markdown);
  if (found.length === 0) {
    return markdown.trim() ? [{ kind: "text", text: markdown }] : [];
  }

  const lines = markdown.split("\n");
  const segments: ArtifactSegment[] = [];
  let at = 0;

  found.forEach((artifact, offset) => {
    const before = lines.slice(at, artifact.line).join("\n");
    if (before.trim()) segments.push({ kind: "text", text: before });

    segments.push({
      kind: "artifact",
      index: firstIndex + offset,
      artifact,
      raw: lines.slice(artifact.line, artifact.endLine + 1).join("\n"),
    });

    at = artifact.endLine + 1;
  });

  const after = lines.slice(at).join("\n");
  if (after.trim()) segments.push({ kind: "text", text: after });

  return segments;
}

/**
 * A message still arriving, split just far enough to hide the markup (§13, §20).
 *
 * Prose stays an unparsed paragraph while a turn streams — re-parsing and
 * re-highlighting a growing message on every delta is the work that drops frames
 * on the target hardware, and that decision stands. What does not stand is
 * showing the artifact itself as prose: a pupil who asked for a page watched
 * `<!doctype html>` scroll past for the length of the file.
 *
 * So the boundaries are scanned and nothing else is: one `split("\n")` and one
 * regular expression per line, no markdown and no highlighting. Every artifact
 * fence collapses to a stub — a closed one naming what was built, the trailing
 * open one saying it is being built. When the turn settles the real cards
 * replace them through `artifactSegments`, which is where the refs exist.
 */
export type StreamingSegment =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "artifact"; readonly artifact: DetectedArtifact }
  /** The fence the message ends inside: a title and a language, and no source yet. */
  | {
      readonly kind: "pending";
      readonly language: ArtifactLanguage;
      readonly key: string | null;
      readonly title: string | null;
    };

/** Anything that is not whitespace, tested without allocating a trimmed copy. */
const NON_BLANK = /\S/;

export function streamingSegments(markdown: string): StreamingSegment[] {
  // The scanner's own line array, not a second split of the same string: this
  // runs on every delta of a growing message, and §20 budgets it at one pass.
  return segmentsOf(scanFences(markdown), null);
}

/**
 * A whole streaming message's text parts, scanned as one document (§13, §20).
 *
 * Prose arrives as several parts: `StreamingTurn` starts a new one wherever a
 * tool call or a generated image landed between two deltas. Scanned apart, a
 * fence that spans one of those boundaries is lost — the part after it has no
 * opening line, so the pupil watches the rest of their page arrive as prose,
 * which is the one thing the stub card exists to prevent.
 *
 * So every open fence is carried from part to part, an ordinary code block's as
 * much as an artifact's: a `js` block whose closing line lands in the next part
 * would otherwise leave that line reading as an *opening* one, and the artifact
 * behind it parsed as the body of a code block.
 *
 * The part that opened a fence owns its card, and the parts continuing it render
 * only what follows the close — so one artifact is one stub, wherever the tool
 * call fell inside it. When the fence does close, that stub stops saying the
 * artifact is being built and names it, in the place it has been all along.
 *
 * Each part is still scanned by line, so a boundary that fell mid-line leaves
 * the two halves as two lines for the length of the scan. That is only ever
 * wrong for a delta that stopped immediately before a line the scan would read
 * as a fence, and only until the turn settles.
 *
 * Returns one segment list per text given, in the order they were given.
 */
export function streamingMessageSegments(texts: readonly string[]): StreamingSegment[][] {
  const scans: StreamingSegment[][] = [];
  let carried: OpenFence | null = null;
  /**
   * The scan whose stub owns the open fence, the pieces of source it has
   * collected, and whether any of them holds anything.
   *
   * `bodied` is carried rather than derived: this whole walk runs again on every
   * delta, and re-reading the pieces collected so far to answer one boolean
   * would make a long artifact cost more with every part it crosses. They are
   * joined once, when the fence closes and a card needs its source.
   */
  let stub: { at: number; open: OpenFence; source: string[]; bodied: boolean } | null = null;

  texts.forEach((text, at) => {
    const scanned = scanFences(text, carried);

    // At most one block can have opened before this part: the carried one, and
    // nothing else can open until it closes.
    const closed = scanned.blocks.find((block) => block.line === CARRIED);
    const piece = closed ? closed.source : text;
    const bodied = stub ? stub.bodied || NON_BLANK.test(piece) : false;

    // Whether the carried block has a body at all is the caller's to know: it is
    // spread across the parts the fence crossed, and the scan sees one of them.
    scans.push(segmentsOf(scanned, carried ? { bodied } : null));

    if (stub && closed) {
      // Joined with nothing: each piece is the exact substring of its part, and
      // `StreamingTurn` concatenates deltas rather than adding a line between
      // them — a boundary that fell mid-line is one line again here.
      if (bodied) nameStub(scans[stub.at], stub.open, [...stub.source, piece].join(""));
      else unbuildStub(scans[stub.at], texts[stub.at], stub.open);
      stub = null;
    } else if (stub) {
      // Still open, so the whole of this part is inside it.
      stub.source.push(text);
      stub.bodied = bodied;
    }

    const open = scanned.open;
    carried = open;
    if (!open || open.line === CARRIED) return;

    // A fence opened here and is still open: this part owns its stub, if the
    // fence is one the transcript shows a stub for at all.
    if (!artifactLanguage(open.language)) {
      stub = null;
      return;
    }

    const head = scanned.lines.slice(open.line + 1).join("\n");
    stub = { at, open, source: [head], bodied: NON_BLANK.test(head) };
  });

  return scans;
}

/**
 * Turn the stub that said an artifact was being built into the artifact itself.
 *
 * It stays in the part that opened the fence rather than moving to the one that
 * closed it: a card that jumps below the tool call which interrupted it, halfway
 * through a stream, is worse than one that stays where the pupil last saw it.
 */
function nameStub(segments: StreamingSegment[], open: OpenFence, source: string): void {
  const at = segments.findIndex((segment) => segment.kind === "pending");
  const language = artifactLanguage(open.language);
  if (at === -1 || !language) return;

  segments[at] = {
    kind: "artifact",
    artifact: {
      language,
      source,
      line: open.line,
      endLine: CARRIED,
      key: normaliseArtifactKey(open.attributes.id),
      title: open.attributes.title?.trim() || null,
    },
  };
}

/**
 * Put a stub back as the fence it was written as, when it held nothing.
 *
 * An empty block is not an artifact — `detectArtifacts` skips it and the settled
 * transcript renders it as written — and the two must not disagree about which
 * blocks were artifacts. Folded into the prose above it where there is any, so
 * what the pupil sees is what a single scan of the whole message would give.
 */
function unbuildStub(segments: StreamingSegment[], text: string, open: OpenFence): void {
  const at = segments.findIndex((segment) => segment.kind === "pending");
  if (at === -1) return;

  const raw = text.split("\n").slice(open.line).join("\n");
  const above = segments[at - 1];

  if (above?.kind === "text") {
    segments.splice(at - 1, 2, { kind: "text", text: `${above.text}\n${raw}` });
    return;
  }

  segments[at] = { kind: "text", text: raw };
}

/**
 * `carriedIn` says the scan began inside a fence an earlier part opened, whose
 * stub that part is already showing — so the block it closes here, and the
 * pending it may still be inside, belong there and are not repeated. Its
 * `bodied` is whether that block has a body anywhere across the parts it
 * crossed, which this scan cannot see for itself.
 */
function segmentsOf(
  scanned: ScannedFences,
  carriedIn: { readonly bodied: boolean } | null,
): StreamingSegment[] {
  const { blocks, open, lines } = scanned;
  const pendingLanguage = open ? artifactLanguage(open.language) : null;

  // A fence that is open but not an artifact — a bare ``` or a js block — is
  // ordinary prose and stays in the paragraph, exactly as it does today.
  const end = pendingLanguage && open ? Math.max(open.line, 0) : lines.length;

  const segments: StreamingSegment[] = [];
  let at = 0;

  for (const block of blocks) {
    const language = artifactLanguage(block.language);
    const carried = block.line === CARRIED;
    // An empty body is not an artifact, here as on the settled path — but a
    // carried block's body is spread over the parts it crossed, so what this
    // scan holds of it says nothing about whether there is one.
    const empty = carried ? !carriedIn?.bodied : !block.source.trim();
    if (!language || empty) continue;

    const before = lines.slice(at, Math.max(block.line, 0)).join("\n");
    if (before.trim()) segments.push({ kind: "text", text: before });

    at = block.endLine + 1;
    if (carried) continue;

    segments.push({
      kind: "artifact",
      artifact: {
        language,
        source: block.source,
        line: block.line,
        endLine: block.endLine,
        key: normaliseArtifactKey(block.attributes.id),
        title: block.attributes.title?.trim() || null,
      },
    });
  }

  const after = lines.slice(at, end).join("\n");
  if (after.trim()) segments.push({ kind: "text", text: after });

  if (pendingLanguage && open && !(carriedIn && open.line === CARRIED)) {
    segments.push({
      kind: "pending",
      language: pendingLanguage,
      key: normaliseArtifactKey(open.attributes.id),
      title: open.attributes.title?.trim() || null,
    });
  }

  return segments;
}

/** How many artifacts a piece of prose holds — the running count between parts. */
export function artifactSegmentCount(markdown: string): number {
  return detectArtifacts(markdown).length;
}
