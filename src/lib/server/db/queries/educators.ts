import { eq } from "drizzle-orm";
import type { AppDatabase } from "../client";
import { type Educator, educator } from "../schema";

/**
 * The operator account (PRD §7, §19).
 *
 * A single row in practice, but the table is keyed by username rather than
 * pinned to one row: the recovery path re-seeds from deployment configuration,
 * and an operator who changes the configured username should get an account
 * rather than a constraint violation.
 *
 * No function here accepts or returns a plaintext password — hashing happens in
 * `$lib/server/auth/educator` before it reaches the database (§7, §21).
 */

/** Insert, or replace the hash of an existing username. */
export function createEducator(
  db: AppDatabase,
  input: { username: string; passwordHash: string },
): Educator {
  const [row] = db
    .insert(educator)
    .values(input)
    .onConflictDoUpdate({
      target: educator.username,
      set: { passwordHash: input.passwordHash, updatedAt: new Date() },
    })
    .returning()
    .all();
  return row;
}

export function findEducatorByUsername(db: AppDatabase, username: string): Educator | undefined {
  return db.select().from(educator).where(eq(educator.username, username)).get();
}

export function getEducatorById(db: AppDatabase, educatorId: string): Educator | undefined {
  return db.select().from(educator).where(eq(educator.id, educatorId)).get();
}
