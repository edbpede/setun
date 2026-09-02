import type { ArtifactLanguage } from "./types";

/**
 * What names an artifact across turns (PRD §13).
 *
 * §13's continuity heuristic anchors on "the conversation's most recent
 * artifact", which is the whole of the identity the original design had. That is
 * enough for one thing built once and not enough for a lesson: an interleaved
 * `svg` steals the anchor from the `html` page being worked on, and two
 * unrelated HTML things collapse into one row.
 *
 * So the model is asked to write an id on the fence — ```` ```html id=home-page
 * title="Min hjemmeside" ```` — and that id is the key. It stays a heuristic
 * underneath: a model that writes no id still resolves by language, exactly as
 * before. "The guess is presentational only — every version is retained, so a
 * wrong guess loses nothing."
 *
 * Dependency-free, like everything under `$lib/artifacts`: the server records
 * with these rules, the browser renders with them, and the sandbox origin shares
 * the module.
 */

/**
 * A short lowercase slug, which is what a model reliably writes twice.
 *
 * Bounded at 64 characters because a key is an identifier and not a sentence,
 * and restricted to characters that survive a round trip through a fence info
 * string, a URL and a database column without escaping.
 */
export const ARTIFACT_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/**
 * The key an `id=` attribute names, or null when it names nothing usable.
 *
 * Lowercased first, so `id=Home-Page` and `id=home-page` are one artifact: a
 * model that varies its own capitalisation between turns is the ordinary case,
 * and treating those as two things is exactly the fork this exists to stop.
 */
export function normaliseArtifactKey(value: string | null | undefined): string | null {
  if (!value) return null;

  const normalised = value.trim().toLowerCase();
  return ARTIFACT_KEY_PATTERN.test(normalised) ? normalised : null;
}

/**
 * A key for an artifact whose model never wrote one.
 *
 * Derived from the row's own identifier rather than invented, so it is stable
 * across turns and unique without a lookup. It is shown to the model in the
 * state note, so a model that adopts it lands back on the same row — which is
 * why `effectiveArtifactKey` has to resolve to the same string.
 */
export function fallbackArtifactKey(input: { language: ArtifactLanguage; id: string }): string {
  return `${input.language}-${input.id.slice(0, 6).toLowerCase()}`;
}

/** The key an artifact answers to: its own if it has one, else the fallback. */
export function effectiveArtifactKey(input: {
  language: ArtifactLanguage;
  id: string;
  key: string | null;
}): string {
  return normaliseArtifactKey(input.key) ?? fallbackArtifactKey(input);
}

/** Titles are written into a fence info string, so they carry no quote or newline. */
const TITLE_MAX = 120;

function sanitiseTitle(title: string): string {
  return title
    .replace(/[`"'\r\n]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, TITLE_MAX);
}

/**
 * The info string an artifact block carries, as the model is asked to write it.
 *
 * Used when an edited artifact is carried back into context, so what the model
 * reads is shaped exactly like what it is asked to produce — a block it can
 * copy the identity off rather than one it has to translate.
 */
export function fenceInfo(
  language: ArtifactLanguage,
  identity: { key?: string | null; title?: string | null },
): string {
  const key = normaliseArtifactKey(identity.key);
  const title = identity.title ? sanitiseTitle(identity.title) : "";

  return [language, key ? `id=${key}` : "", title ? `title="${title}"` : ""]
    .filter((part) => part.length > 0)
    .join(" ");
}
