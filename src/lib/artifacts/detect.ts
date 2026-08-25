import { fencedBlocks } from "./fences";
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

    found.push({ language, source: block.source, line: block.line });
  }

  return found;
}
