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
 * Kept as a pure decision over the one fact it needs, so the rule is testable
 * without a database and cannot quietly acquire a second input.
 */

export interface ArtifactAnchor {
  readonly id: string;
  readonly language: ArtifactLanguage;
}

export type ContinuityDecision =
  | { readonly kind: "version"; readonly artifactId: string }
  | { readonly kind: "new" };

export function continuityDecision(input: {
  /** The language of the block just emitted. */
  readonly language: ArtifactLanguage;
  /** The conversation's most recent artifact, or null when it has none yet. */
  readonly latest: ArtifactAnchor | null;
}): ContinuityDecision {
  if (input.latest && input.latest.language === input.language) {
    return { kind: "version", artifactId: input.latest.id };
  }

  return { kind: "new" };
}
