import { and, eq, inArray, isNull } from "drizzle-orm";
import type { AppDatabase } from "../client";
import { type Session, session, student } from "../schema";

/**
 * Session rows (PRD §7).
 *
 * Only token digests cross this boundary; the plaintext token exists solely in
 * the cookie. `$lib/server/auth/sessions` owns minting and hashing.
 */

export function createSessionRow(
  db: Pick<AppDatabase, "insert">,
  input: {
    tokenDigest: string;
    ownerKind: "student" | "educator";
    ownerId: string;
    expiresAt: Date;
    /**
     * Stamped explicitly rather than defaulted.
     *
     * The per-lesson policy asks whether a session predates the classroom's last
     * close (§7), so the row's creation instant and the instant its expiry was
     * computed from have to be the same one.
     */
    createdAt: Date;
  },
): Session {
  const [row] = db
    .insert(session)
    .values({ ...input, lastSeenAt: input.createdAt })
    .returning()
    .all();
  return row;
}

export function findSessionByDigest(db: AppDatabase, tokenDigest: string): Session | undefined {
  return db.select().from(session).where(eq(session.tokenDigest, tokenDigest)).get();
}

/** Sliding expiry: every resolved request pushes the window out (§7). */
export function touchSession(
  db: AppDatabase,
  input: { sessionId: string; expiresAt: Date; lastSeenAt: Date },
): void {
  db.update(session)
    .set({ expiresAt: input.expiresAt, lastSeenAt: input.lastSeenAt })
    .where(eq(session.id, input.sessionId))
    .run();
}

export function invalidateSession(db: AppDatabase, tokenDigest: string): void {
  db.update(session)
    .set({ invalidatedAt: new Date() })
    .where(and(eq(session.tokenDigest, tokenDigest), isNull(session.invalidatedAt)))
    .run();
}

/**
 * Invalidate every live session of one owner.
 *
 * The mechanism behind rotation, disabling, and the educator's force-logout —
 * all of which must take effect immediately (§7, §21).
 */
export function invalidateOwnerSessions(
  db: AppDatabase,
  input: { ownerKind: "student" | "educator"; ownerId: string },
): number {
  const rows = db
    .update(session)
    .set({ invalidatedAt: new Date() })
    .where(
      and(
        eq(session.ownerKind, input.ownerKind),
        eq(session.ownerId, input.ownerId),
        isNull(session.invalidatedAt),
      ),
    )
    .returning({ id: session.id })
    .all();
  return rows.length;
}

/**
 * Invalidate every live student session in one classroom — force-logout (§7, §21).
 *
 * One statement rather than a loop over the roster: the educator's action is
 * described as immediate, and a partially applied force-logout would leave some
 * pupils signed in with no indication of which.
 */
export function invalidateClassroomSessions(db: AppDatabase, classroomId: string): number {
  const rows = db
    .update(session)
    .set({ invalidatedAt: new Date() })
    .where(
      and(
        eq(session.ownerKind, "student"),
        isNull(session.invalidatedAt),
        inArray(
          session.ownerId,
          db.select({ id: student.id }).from(student).where(eq(student.classroomId, classroomId)),
        ),
      ),
    )
    .returning({ id: session.id })
    .all();

  return rows.length;
}
