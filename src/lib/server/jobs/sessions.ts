import { subDays } from "date-fns";
import type { AppDatabase } from "../db/client";
import { deleteDeadSessions } from "../db/queries/retention";
import { log } from "../logging";
import type { ScheduledJob } from "./scheduler";

/**
 * Sweeping session rows that can never authenticate again (PRD §7, §16).
 *
 * This job enforces nothing. Expiry and invalidation are decided when a session
 * is resolved, and a row that survives here is already refused there — rotation,
 * disabling and force-logout "invalidate sessions immediately" (§21) and do not
 * wait on a sweep. What this removes is storage, so a term's worth of lessons
 * does not accumulate rows nobody will read.
 *
 * Hence the grace period: an expired row is inert but legible, and deleting it
 * the instant it lapses makes "your session ended" indistinguishable from "no
 * such session" while somebody is still asking which it was.
 */

export const SESSION_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;

export const SESSION_SWEEP_GRACE_DAYS = 2;

/** Rows expired or invalidated longer ago than the grace period. */
export function sweepSessions(db: AppDatabase, now: Date = new Date()): number {
  return deleteDeadSessions(db, subDays(now, SESSION_SWEEP_GRACE_DAYS));
}

export function sessionSweepJob(db: AppDatabase): ScheduledJob {
  return {
    name: "session-sweep",
    intervalMs: SESSION_SWEEP_INTERVAL_MS,
    runAtStart: true,
    run(now) {
      const removed = sweepSessions(db, now);
      if (removed > 0) log.info(`session sweep removed ${removed} dead session row(s)`);
    },
  };
}
