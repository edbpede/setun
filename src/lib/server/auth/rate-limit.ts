import { and, desc, eq, gte, lt } from "drizzle-orm";
import type { AppDatabase } from "../db/client";
import { loginAttempt } from "../db/schema";

/**
 * Login rate limiting — in-application and SQLite-backed, because Caddy performs
 * none (PRD §7). Both axes are checked independently: per credential digest, and
 * per IP.
 *
 * Thresholds are Appendix A, named rather than inlined so the panel can surface
 * them later without hunting for magic numbers.
 */

export const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;

/** Per digest: after 5 consecutive failures in the window, delay 1 s doubling to 60 s. */
export const DIGEST_FAILURE_THRESHOLD = 5;
export const DIGEST_BASE_DELAY_MS = 1_000;
export const DIGEST_MAX_DELAY_MS = 60_000;

/** Per IP: at most 30 attempts per window, then refusal until it passes. */
export const IP_ATTEMPT_LIMIT = 30;

export interface RateLimitDecision {
  /** True when the attempt must be refused outright without checking the credential. */
  readonly blocked: boolean;
  /** Delay to apply before responding, in milliseconds. */
  readonly delayMs: number;
}

function attemptsSince(
  db: AppDatabase,
  input: { scope: "ip" | "digest"; key: string; since: Date },
) {
  return db
    .select({ successful: loginAttempt.successful, createdAt: loginAttempt.createdAt })
    .from(loginAttempt)
    .where(
      and(
        eq(loginAttempt.scope, input.scope),
        eq(loginAttempt.key, input.key),
        gte(loginAttempt.createdAt, input.since),
      ),
    )
    .orderBy(desc(loginAttempt.createdAt))
    .all();
}

/**
 * Consecutive failures at the head of the window.
 *
 * Counting *consecutive* failures rather than all of them is what makes a
 * successful login reset the progression, so a student who mistypes four times
 * and then gets in is not left throttled.
 */
function consecutiveFailures(rows: { successful: boolean }[]): number {
  let count = 0;
  for (const row of rows) {
    if (row.successful) break;
    count++;
  }
  return count;
}

/** Progressive delay: 1 s doubling per failure past the threshold, capped at 60 s. */
export function delayForFailures(failures: number): number {
  if (failures < DIGEST_FAILURE_THRESHOLD) return 0;
  const doublings = failures - DIGEST_FAILURE_THRESHOLD;
  return Math.min(DIGEST_BASE_DELAY_MS * 2 ** doublings, DIGEST_MAX_DELAY_MS);
}

/**
 * Decide before verifying a credential.
 *
 * The digest is of the submitted code, so an unknown code is rate limited on
 * exactly the same path as a known one — the limiter never reveals whether a
 * code exists (§7, §21).
 */
export function checkRateLimit(
  db: AppDatabase,
  input: { ip: string; digest: string; now?: Date },
): RateLimitDecision {
  const now = input.now ?? new Date();
  const since = new Date(now.getTime() - RATE_LIMIT_WINDOW_MS);

  const ipAttempts = attemptsSince(db, { scope: "ip", key: input.ip, since });
  if (ipAttempts.length >= IP_ATTEMPT_LIMIT) {
    return { blocked: true, delayMs: 0 };
  }

  const digestAttempts = attemptsSince(db, { scope: "digest", key: input.digest, since });
  return { blocked: false, delayMs: delayForFailures(consecutiveFailures(digestAttempts)) };
}

/** Both axes are recorded for every attempt, successful or not. */
export function recordAttempt(
  db: AppDatabase,
  input: { ip: string; digest: string; successful: boolean },
): void {
  db.insert(loginAttempt)
    .values([
      { scope: "ip", key: input.ip, successful: input.successful },
      { scope: "digest", key: input.digest, successful: input.successful },
    ])
    .run();
}

/** Housekeeping for the Phase 5 scheduler; rows outside the window decide nothing. */
export function pruneAttemptsBefore(db: AppDatabase, cutoff: Date): number {
  const rows = db
    .delete(loginAttempt)
    .where(lt(loginAttempt.createdAt, cutoff))
    .returning({ id: loginAttempt.id })
    .all();
  return rows.length;
}
