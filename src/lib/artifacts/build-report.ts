import { effectiveLanguage } from "./identity";
import { type ProjectFiles, sameFiles } from "./project";
import type { ArtifactLanguage, BuildStatus } from "./types";

/**
 * What a run tells the server, and therefore the model (PRD §13).
 *
 * A failure used to reach the panel as text and stop there: the pupil saw the
 * compiler's words, the model saw nothing, and "it does not work" was the whole
 * of the next turn's information. The browser is the only thing that knows
 * whether an artifact ran, so it reports the outcome onto the version it ran,
 * and the next turn's prompt states it.
 *
 * Three conditions bound what is reported, and the first two are about *which*
 * source ran:
 *
 * - The outcome must belong to the stored project. A pupil running an unsaved
 *   draft is running something the version does not hold, and stamping the
 *   version with that result would tell the model a lie about its own code. Every
 *   file, not only the entry: a stylesheet edited but not saved changes what the
 *   pupil sees run.
 * - And to the tag it ran under. A Restore can bring back a source the artifact
 *   already holds under a different tag — same text, different pipeline — and
 *   the revision that records the new tag is still being stored while the frame
 *   is already running. Without this the html run's result lands on the svelte
 *   version it replaced, which is the one thing this file exists to prevent.
 * - The status must differ from what is stored. Re-running working code is the
 *   ordinary case and must not be a PATCH per run.
 */

export interface BuildOutcome {
  /** The project that actually ran, so a draft can be told from the version. */
  readonly files: ProjectFiles;
  readonly entry: string;
  /** And the tag it ran under, so a restore can be told from the version too. */
  readonly language: ArtifactLanguage | null;
  readonly status: BuildStatus;
  /** The compiler's or the browser's own words; text, never markup (§13, §21). */
  readonly message: string | null;
}

export interface BuildTarget {
  readonly id: string;
  readonly language: ArtifactLanguage;
  readonly latest: {
    readonly id: string;
    readonly files: ProjectFiles;
    readonly entry: string;
    readonly language?: ArtifactLanguage | null;
    readonly buildStatus?: BuildStatus | null;
    readonly buildMessage?: string | null;
  };
}

export interface BuildReport {
  readonly artifactId: string;
  readonly versionId: string;
  readonly status: BuildStatus;
  readonly message: string | null;
}

/** An error message is for a pupil and a prompt, not for a log. */
const MESSAGE_MAX = 2_000;

export function buildReportFor(
  open: BuildTarget | null,
  outcome: BuildOutcome | null,
): BuildReport | null {
  if (!open || !outcome) return null;
  if (!sameFiles(outcome.files, open.latest.files)) return null;
  if (outcome.entry !== open.latest.entry) return null;
  if (outcome.language !== effectiveLanguage(open, open.latest)) return null;
  if ((open.latest.buildStatus ?? null) === outcome.status) return null;

  return {
    artifactId: open.id,
    versionId: open.latest.id,
    status: outcome.status,
    message: outcome.message ? outcome.message.slice(0, MESSAGE_MAX) : null,
  };
}
