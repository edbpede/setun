import { type DetectedArtifact, detectArtifacts } from "./detect";

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

/** How many artifacts a piece of prose holds — the running count between parts. */
export function artifactSegmentCount(markdown: string): number {
  return detectArtifacts(markdown).length;
}
