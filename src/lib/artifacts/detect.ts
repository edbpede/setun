import { fencedBlocks } from "./fences";
import { normaliseArtifactKey } from "./identity";
import { type ArtifactLanguage, isArtifactLanguage } from "./types";

/**
 * Which fenced blocks are artifacts (PRD §13).
 *
 * "No tool call, no model-side capability, no special protocol — this works with
 * any model the gateway offers." So the only signal is the fence tag, and the
 * recognised set is closed: `html` and `svg` render statically, `jsx`, `tsx` and
 * `svelte` compile, and everything else — "including bare `js`, `ts`, and `css`"
 * — stays an ordinary highlighted code block, because a fragment without markup
 * has nothing to render.
 */

export interface DetectedArtifact {
  readonly language: ArtifactLanguage;
  readonly source: string;
  /** Position of the opening fence, so blocks are recorded in the order written. */
  readonly line: number;
  /** Position of the closing fence, so a whole block can be replaced by line. */
  readonly endLine: number;
  /**
   * The `id=` the model wrote, normalised; null when it wrote none or wrote
   * something that is not a slug. This is what continuity resolves on (§13).
   */
  readonly key: string | null;
  /** The `title=` the model wrote; null when it wrote none. */
  readonly title: string | null;
}

/**
 * Resolve a fence tag to an artifact language, or null to leave it a code block.
 *
 * Deliberately not alias-tolerant. `js` is not `jsx` and `htm` is not `html`:
 * a tag Setun does not recognise renders as code, which is the safe outcome,
 * whereas guessing renders somebody's plain snippet in an iframe.
 */
export function artifactLanguage(tag: string | null | undefined): ArtifactLanguage | null {
  if (!tag) return null;

  const normalised = tag.trim().toLowerCase();
  return isArtifactLanguage(normalised) ? normalised : null;
}

/** Every artifact in a piece of model prose, in the order it was written. */
export function detectArtifacts(markdown: string): DetectedArtifact[] {
  const found: DetectedArtifact[] = [];

  for (const block of fencedBlocks(markdown)) {
    const language = artifactLanguage(block.language);
    // An empty block is a fence the model opened and closed with nothing in it.
    if (!language || !block.source.trim()) continue;

    found.push({
      language,
      source: block.source,
      line: block.line,
      endLine: block.endLine,
      key: normaliseArtifactKey(block.attributes.id),
      title: block.attributes.title?.trim() || null,
    });
  }

  return found;
}
