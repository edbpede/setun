import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { createdAt, primaryId } from "./helpers";

/**
 * A logged-in browser (PRD §7).
 *
 * Students and educators share the table but not the namespace: `ownerKind`
 * separates them, so an educator session can never resolve to a student and the
 * educator role check has something concrete to test (§21).
 *
 * The cookie carries a high-entropy token; only its SHA-256 digest is stored, so
 * a database read cannot mint a session.
 */
export const session = sqliteTable(
  "session",
  {
    id: primaryId(),
    tokenDigest: text().notNull().unique(),
    ownerKind: text({ enum: ["student", "educator"] }).notNull(),
    ownerId: text().notNull(),
    createdAt: createdAt(),
    /** Drives sliding expiry: 14 days for students, 7 for educators (§7, Appendix A). */
    lastSeenAt: integer({ mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    expiresAt: integer({ mode: "timestamp_ms" }).notNull(),
    /** Set by rotation, disabling, and force-logout — all invalidate immediately (§7, §21). */
    invalidatedAt: integer({ mode: "timestamp_ms" }),
  },
  (t) => [index("session_owner_idx").on(t.ownerKind, t.ownerId)],
);

export type Session = typeof session.$inferSelect;
