import type { BuildStatus } from "./types";

/**
 * What a run tells the server, and therefore the model (PRD §13).
 *
 * A failure used to reach the panel as text and stop there: the pupil saw the
 * compiler's words, the model saw nothing, and "it does not work" was the whole
 * of the next turn's information. The browser is the only thing that knows
 * whether an artifact ran, so it reports the outcome onto the version it ran,
 * and the next turn's prompt states it.
 *
 * Two conditions bound what is reported, and both are about *which* source ran:
 *
 * - The outcome must belong to the stored source. A pupil running an unsaved
 *   draft is running something the version does not hold, and stamping the
 *   version with that result would tell the model a lie about its own code.
 * - The status must differ from what is stored. Re-running working code is the
 *   ordinary case and must not be a PATCH per run.
 */

export interface BuildOutcome {
  /** The source that actually ran, so a draft can be told from the version. */
  readonly source: string;
  readonly status: BuildStatus;
  /** The compiler's or the browser's own words; text, never markup (§13, §21). */
  readonly message: string | null;
}

export interface BuildTarget {
  readonly id: string;
  readonly latest: {
    readonly id: string;
    readonly source: string;
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
  if (outcome.source !== open.latest.source) return null;
  if ((open.latest.buildStatus ?? null) === outcome.status) return null;

  return {
    artifactId: open.id,
    versionId: open.latest.id,
    status: outcome.status,
    message: outcome.message ? outcome.message.slice(0, MESSAGE_MAX) : null,
  };
}
