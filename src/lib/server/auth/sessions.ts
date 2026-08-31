import { previousCloseAt } from "../classroom/schedule";
import type { AppDatabase } from "../db/client";
import { getClassroom } from "../db/queries/classrooms";
import {
  createSessionRow,
  findSessionByDigest,
  invalidateOwnerSessions,
  invalidateSession,
  touchSession,
} from "../db/queries/sessions";
import { getStudentById } from "../db/queries/students";
import type { Session, Student } from "../db/schema";

/**
 * Session lifecycle (PRD §7).
 *
 * The cookie carries a 256-bit random token; the database stores only its
 * SHA-256 digest, so a database read cannot mint a session. The token is already
 * high-entropy, so the digest is unkeyed — there is nothing to brute-force,
 * unlike the student code which is typed by a human and therefore peppered.
 */

export const SESSION_COOKIE_NAME = "setun_session";

/**
 * The educator cookie, deliberately a different name.
 *
 * One cookie for both roles would mean an educator signing in on a classroom
 * machine silently replaced the pupil's session, and back again. Separate names
 * let the two coexist, and keep the namespaces as distinct in the browser as
 * they are in the table (§7, §21).
 */
export const EDUCATOR_SESSION_COOKIE_NAME = "setun_educator_session";

/** Sliding expiry defaults (§7, Appendix A). */
export const STUDENT_SESSION_TTL_DAYS = 14;
export const EDUCATOR_SESSION_TTL_DAYS = 7;

const TOKEN_BYTES = 32;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export type SessionOwnerKind = "student" | "educator";

export interface IssuedSession {
  /** Goes in the cookie and nowhere else. Never persisted, never logged. */
  readonly token: string;
  readonly session: Session;
}

export function ttlDaysFor(ownerKind: SessionOwnerKind): number {
  return ownerKind === "student" ? STUDENT_SESSION_TTL_DAYS : EDUCATOR_SESSION_TTL_DAYS;
}

/**
 * Digest of a session token.
 *
 * Exported because the educator resolver performs the same lookup against the
 * same table; two implementations of this would be two chances to diverge.
 */
export function hashSessionToken(token: string): string {
  return new Bun.CryptoHasher("sha256").update(token).digest("hex");
}

/**
 * A fresh 256-bit token, base64url encoded.
 *
 * Exported because the first-run setup claim needs a bearer secret with exactly
 * these properties — high entropy, stored only as a digest, carried only in a
 * cookie — and a second implementation of "mint a random token" is a second
 * chance to pick the wrong byte count (§7, §21).
 */
export function mintSessionToken(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(TOKEN_BYTES))).toString("base64url");
}

export function createSession(
  db: Pick<AppDatabase, "insert">,
  input: { ownerKind: SessionOwnerKind; ownerId: string; now?: Date },
): IssuedSession {
  const token = mintSessionToken();
  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + ttlDaysFor(input.ownerKind) * MS_PER_DAY);

  const session = createSessionRow(db, {
    tokenDigest: hashSessionToken(token),
    ownerKind: input.ownerKind,
    ownerId: input.ownerId,
    expiresAt,
    createdAt: now,
  });

  return { token, session };
}

export interface ResolvedStudentSession {
  readonly session: Session;
  readonly student: Student;
}

/**
 * Resolve a cookie token to a live student session, applying the classroom's
 * session policy (§7).
 *
 * Returns null for every failure mode — unknown, expired, invalidated, belonging
 * to a disabled student, or ended by the lesson closing — because the caller's
 * response is identical in all of them: no session (§7, §21).
 *
 * The sliding window is the classroom's own `sessionSlidingDays`, not the
 * constant: the educator sets the duration in the panel, and a policy nothing
 * reads is not a policy (§7, §8).
 */
export function resolveStudentSession(
  db: AppDatabase,
  token: string,
  now: Date = new Date(),
): ResolvedStudentSession | null {
  const session = findSessionByDigest(db, hashSessionToken(token));
  if (session?.ownerKind !== "student") return null;
  if (session.invalidatedAt !== null) return null;
  if (session.expiresAt.getTime() <= now.getTime()) return null;

  const student = getStudentById(db, session.ownerId);
  // Disabling a student takes effect immediately, without waiting for the
  // session to expire (§7, §21).
  if (student?.status !== "active") return null;

  const classroom = getClassroom(db, student.classroomId);
  if (!classroom) return null;

  // Per-lesson: "sessions end when the classroom closes and students
  // re-authenticate each lesson" (§7). A session minted before the most recent
  // close belonged to a lesson that is over.
  if (classroom.sessionPolicy === "per-lesson") {
    const lastClose = previousCloseAt(classroom, now);
    if (lastClose && session.createdAt.getTime() <= lastClose.getTime()) return null;
  }

  touchSession(db, {
    sessionId: session.id,
    lastSeenAt: now,
    expiresAt: new Date(now.getTime() + classroom.sessionSlidingDays * MS_PER_DAY),
  });

  return { session, student };
}

export function destroySession(db: AppDatabase, token: string): void {
  invalidateSession(db, hashSessionToken(token));
}

/** Rotation, disabling and force-logout all land here (§7, §21). */
export function invalidateAllSessionsFor(
  db: AppDatabase,
  input: { ownerKind: SessionOwnerKind; ownerId: string },
): number {
  return invalidateOwnerSessions(db, input);
}
