import { and, eq, isNull } from "drizzle-orm";
import type { AppDatabase } from "../client";
import { type Session, session } from "../schema";

/**
 * Session rows (PRD §7).
 *
 * Only token digests cross this boundary; the plaintext token exists solely in
 * the cookie. `$lib/server/auth/sessions` owns minting and hashing.
 */

export function createSessionRow(
  db: AppDatabase,
  input: {
    tokenDigest: string;
    ownerKind: "student" | "educator";
    ownerId: string;
    expiresAt: Date;
  },
): Session {
  const [row] = db.insert(session).values(input).returning().all();
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
