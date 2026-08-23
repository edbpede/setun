import type { AppDatabase } from "../db/client";
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

function hashToken(token: string): string {
  return new Bun.CryptoHasher("sha256").update(token).digest("hex");
}

export function createSession(
  db: AppDatabase,
  input: { ownerKind: SessionOwnerKind; ownerId: string; now?: Date },
): IssuedSession {
  const token = Buffer.from(crypto.getRandomValues(new Uint8Array(TOKEN_BYTES))).toString(
    "base64url",
  );
  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + ttlDaysFor(input.ownerKind) * MS_PER_DAY);

  const session = createSessionRow(db, {
    tokenDigest: hashToken(token),
    ownerKind: input.ownerKind,
    ownerId: input.ownerId,
    expiresAt,
  });

  return { token, session };
}

export interface ResolvedStudentSession {
  readonly session: Session;
  readonly student: Student;
}

/**
 * Resolve a cookie token to a live student session, sliding the expiry.
 *
 * Returns null for every failure mode — unknown, expired, invalidated, or
 * belonging to a disabled student — because the caller's response is identical
 * in all of them: no session (§7, §21).
 */
export function resolveStudentSession(
  db: AppDatabase,
  token: string,
  now: Date = new Date(),
): ResolvedStudentSession | null {
  const session = findSessionByDigest(db, hashToken(token));
  if (session?.ownerKind !== "student") return null;
  if (session.invalidatedAt !== null) return null;
  if (session.expiresAt.getTime() <= now.getTime()) return null;

  const student = getStudentById(db, session.ownerId);
  // Disabling a student takes effect immediately, without waiting for the
  // session to expire (§7, §21).
  if (student?.status !== "active") return null;

  touchSession(db, {
    sessionId: session.id,
    lastSeenAt: now,
    expiresAt: new Date(now.getTime() + STUDENT_SESSION_TTL_DAYS * MS_PER_DAY),
  });

  return { session, student };
}

export function destroySession(db: AppDatabase, token: string): void {
  invalidateSession(db, hashToken(token));
}

/** Rotation, disabling and force-logout all land here (§7, §21). */
export function invalidateAllSessionsFor(
  db: AppDatabase,
  input: { ownerKind: SessionOwnerKind; ownerId: string },
): number {
  return invalidateOwnerSessions(db, input);
}
