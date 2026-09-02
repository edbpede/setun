import { effectiveArtifactKey } from "./identity";
import type { ArtifactLanguage } from "./types";

/**
 * Artifact continuity (PRD §13).
 *
 * "Artifact continuity is a heuristic, since no model-side protocol exists: a
 * fenced artifact block whose language matches the conversation's most recent
 * artifact becomes a new version of that artifact; a different language starts a
 * new one. The guess is presentational only — every version is retained, so a
 * wrong guess loses nothing."
 *
 * Still a heuristic, now with one fact ahead of it. The model is asked to write
 * an id on the fence, so when it does, the guess is not a guess: the key decides,
 * and the language may change under it (a page rewritten as a component is the
 * same thing to the pupil). Only a block with no key falls back to the original
 * rule — and to language rather than to "any artifact", because an interleaved
 * `svg` stealing the anchor from the `html` page under construction was the
 * observed failure this replaces.
 *
 * Kept as a pure decision over the facts it needs, so the rule is testable
 * without a database and cannot quietly acquire a second input.
 */

export interface ArtifactAnchor {
  readonly id: string;
  readonly language: ArtifactLanguage;
  /**
   * The key the row *stores*, which is null for every legacy or id-less row.
   * `effectiveArtifactKey` derives the one it answers to from this and the id,
   * so a model adopting the fallback shown in the state note lands back here.
   */
  readonly key: string | null;
  /** Higher is more recent. The last-written artifact of a language wins. */
  readonly updatedAt: number;
  /**
   * The write order `updatedAt` cannot express, higher being later.
   *
   * `updatedAt` is milliseconds, so two artifacts rewritten in one message tie
   * on it; this is the insertion order of the newest revision of each, which is
   * exactly what "last written" means when the clock cannot tell them apart.
   */
  readonly writtenAt: number;
}

export type ContinuityDecision =
  | { readonly kind: "version"; readonly artifactId: string }
  /** The key the new row should carry; null when the model named none. */
  | { readonly kind: "new"; readonly key: string | null };

export function continuityDecision(input: {
  /** The language of the block just emitted. */
  readonly language: ArtifactLanguage;
  /** The id the model wrote on the fence, already normalised; null when absent. */
  readonly key: string | null;
  /** Every artifact of the conversation, in any order. */
  readonly existing: readonly ArtifactAnchor[];
}): ContinuityDecision {
  if (input.key) {
    const match = input.existing.find(
      (anchor) => effectiveArtifactKey({ ...anchor, key: anchor.key }) === input.key,
    );

    // A key that matches wins outright, language included: renaming `html` to
    // `svelte` under one id is a rewrite of one thing, not a second thing.
    // A key that matches nothing is the model naming something new.
    return match ? { kind: "version", artifactId: match.id } : { kind: "new", key: input.key };
  }

  // No key: §13's original rule, narrowed to the language so an artifact of
  // another kind cannot steal the anchor.
  //
  // `updatedAt` is milliseconds, so two artifacts rewritten in one message tie
  // on it; the sort is stable and would then hold whatever order the rows
  // arrived in. The write order settles it, and settles it correctly: the last
  // revision to land wins, which is what "the most recent artifact" means.
  const sameLanguage = input.existing
    .filter((anchor) => anchor.language === input.language)
    .sort((a, b) => b.updatedAt - a.updatedAt || b.writtenAt - a.writtenAt);

  return sameLanguage[0]
    ? { kind: "version", artifactId: sameLanguage[0].id }
    : { kind: "new", key: null };
}
