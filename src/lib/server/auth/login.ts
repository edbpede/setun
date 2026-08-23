import type { AppDatabase } from "../db/client";
import { findStudentByDigest } from "../db/queries/students";
import type { Student } from "../db/schema";
import { digestCode } from "./codes";
import { checkRateLimit, recordAttempt } from "./rate-limit";
import { createSession, type IssuedSession } from "./sessions";

/**
 * The student login decision (PRD §7).
 *
 * Every failure — unknown code, disabled student, throttled digest, exhausted IP
 * — produces the same outcome shape, so nothing about the response discloses
 * whether a code exists (§7, §21). The route turns that single outcome into one
 * message; it has no branch to leak.
 *
 * Timing is levelled the same way: the digest is computed before any lookup, so
 * a miss and a hit do the same HMAC work, and the whole attempt is held to a
 * floor duration regardless of which path it took.
 */

/**
 * Minimum wall-clock time for any attempt.
 *
 * Comfortably above the spread between a hit and a miss (an indexed lookup and
 * a session insert), so the observable duration is the floor rather than the
 * work done underneath it.
 */
export const LOGIN_MINIMUM_DURATION_MS = 250;

export type LoginResult =
  | { readonly ok: true; readonly student: Student; readonly session: IssuedSession }
  | { readonly ok: false };

const FAILURE: LoginResult = { ok: false };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Verify a submitted code and, on success, establish a session.
 *
 * `ip` is the client address the route resolved; it is one of the two rate-limit
 * axes and never reaches the browser.
 */
export async function attemptStudentLogin(
  db: AppDatabase,
  input: { code: string; ip: string; pepper: string },
): Promise<LoginResult> {
  const startedAt = Date.now();

  const settle = async (result: LoginResult, extraDelayMs = 0): Promise<LoginResult> => {
    const elapsed = Date.now() - startedAt;
    const remaining = LOGIN_MINIMUM_DURATION_MS + extraDelayMs - elapsed;
    if (remaining > 0) await sleep(remaining);
    return result;
  };

  // Computed first and unconditionally: this is the work that would otherwise
  // differ between a plausible code and a malformed one.
  const digest = await digestCode(input.code, input.pepper);

  const limit = checkRateLimit(db, { ip: input.ip, digest });
  if (limit.blocked) {
    // Deliberately not recorded: a refused attempt never reached the credential,
    // and counting it would let one IP throttle a digest it does not own.
    return settle(FAILURE);
  }

  const student = findStudentByDigest(db, digest);
  const authenticated = student !== undefined && student.status === "active";

  recordAttempt(db, { ip: input.ip, digest, successful: authenticated });

  if (!authenticated) return settle(FAILURE, limit.delayMs);

  const session = createSession(db, { ownerKind: "student", ownerId: student.id });
  return settle({ ok: true, student, session });
}
