/**
 * What an artifact is (PRD §13).
 *
 * "Artifacts are detected by the renderer from fenced code blocks with
 * recognised language tags: `html` and `svg` become Tier 0 artifacts; `jsx`,
 * `tsx`, and `svelte` become Tier 1 artifacts. Every other tag — including bare
 * `js`, `ts`, and `css` — remains an ordinary highlighted code block."
 *
 * This module is imported by the server, by the chat client, and by the
 * separate-origin sandbox host, so it depends on nothing but TypeScript.
 */

/** The five recognised tags, in the order §13 introduces them. */
export const ARTIFACT_LANGUAGES = ["html", "svg", "jsx", "tsx", "svelte"] as const;

export type ArtifactLanguage = (typeof ARTIFACT_LANGUAGES)[number];

/**
 * Tier 0 renders as-is; Tier 1 goes through the sandbox compiler first (§13).
 *
 * The tier is derived rather than stored: it is a property of the language, and
 * a stored copy is a second thing that can disagree with the first.
 */
export type ArtifactTier = 0 | 1;

/** Who wrote a version — the model, or the student editing it afterwards (§13). */
export const VERSION_AUTHORS = ["model", "student"] as const;
export type VersionAuthor = (typeof VERSION_AUTHORS)[number];

export function isArtifactLanguage(value: string): value is ArtifactLanguage {
  return (ARTIFACT_LANGUAGES as readonly string[]).includes(value);
}

export function tierOf(language: ArtifactLanguage): ArtifactTier {
  return language === "html" || language === "svg" ? 0 : 1;
}

/**
 * What happened the last time a version was run in the sandbox (§13).
 *
 * The first terminal word per run wins: an error before the artifact acks its
 * mount is `failed`, one after it is `threw`. The distinction is not academic —
 * a page that mounted and then threw is on the pupil's screen, and calling that
 * "did not run" tells the model to rewrite a file that very nearly works, while
 * calling it "ok" tells the model everything is fine while the pupil is looking
 * at an error strip. "Ran, then threw: …" is what gets fixed in one revision.
 *
 * Absent means "not run", which is the fourth value and is spelled `null` rather
 * than enumerated. Stored as bare `text`, so the enum is type-only.
 */
export const BUILD_STATUSES = ["ok", "failed", "threw"] as const;
export type BuildStatus = (typeof BUILD_STATUSES)[number];
