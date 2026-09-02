import { eq } from "drizzle-orm";
import type { AppDatabase } from "../db/client";
import { findStudentByDigest } from "../db/queries/students";
import { type Student, student as studentTable } from "../db/schema";
import { digestCode } from "./codes";
import { checkRateLimit, recordAttempt, recordRefusedAttempt } from "./rate-limit";
import { createSession, type IssuedSession } from "./sessions";

/**
 * The student login decision (PRD §7).
 *
 * Every *credential* failure — unknown code, disabled student, throttled digest
 * — produces the same outcome, so nothing about the response discloses whether a
 * code exists (§7, §21). An exhausted per-IP budget is reported separately: it
 * is a property of the address, not of any credential, so naming it leaks
 * nothing and saves a class from hunting for a typo in a code that is correct.
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

/**
 * Why a sign-in did not happen.
 *
 * `rejected` covers every credential outcome — unknown code, disabled pupil, a
 * digest still serving its progressive delay — and they are deliberately one
 * value: nothing in the response may disclose whether a code exists (§7, §21).
 *
 * `rate-limited` is a property of the address rather than of the credential, so
 * naming it discloses nothing about any code. Telling a pupil their code is
 * wrong when it is right, and their next twenty attempts will be refused too, is
 * how a class loses a lesson to a message that sent them looking in the wrong
 * place.
 */
export type LoginFailure = "rejected" | "rate-limited";

export type LoginResult =
  | { readonly ok: true; readonly student: Student; readonly session: IssuedSession }
  | { readonly ok: false; readonly failure: LoginFailure };

const REJECTED: LoginResult = { ok: false, failure: "rejected" };
const RATE_LIMITED: LoginResult = { ok: false, failure: "rate-limited" };

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
    // Recorded under `ip-refused`, which no limiter reads: an attempt that never
    // reached the credential must not extend the window that refused it, and
    // must not be counted against a digest this address does not own. Without
    // any record at all an operator could not tell a throttled class from a
    // quiet one.
    recordRefusedAttempt(db, { ip: input.ip });
    return settle(RATE_LIMITED);
  }

  const student = findStudentByDigest(db, digest);
  const authenticated =
    student?.status === "active"
      ? db.transaction(
          (tx) => {
            const current = tx
              .select()
              .from(studentTable)
              .where(eq(studentTable.id, student.id))
              .get();

            // Rotation may have replaced the digest after the first lookup.
            // Revalidate it under the same writer reservation that inserts the
            // session, so rotation either revokes this session or wins first
            // and prevents it from being created.
            if (current?.status !== "active" || current.credentialDigest !== digest) return null;

            return {
              ok: true as const,
              student: current,
              session: createSession(tx, { ownerKind: "student", ownerId: current.id }),
            };
          },
          { behavior: "immediate" },
        )
      : null;

  recordAttempt(db, { ip: input.ip, digest, successful: authenticated !== null });

  if (!authenticated) return settle(REJECTED, limit.delayMs);

  return settle(authenticated);
}
