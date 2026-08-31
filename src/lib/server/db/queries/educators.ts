import { asc, eq } from "drizzle-orm";
import type { AppDatabase } from "../client";
import { type Educator, educator } from "../schema";

/**
 * The operator account (PRD §7, §19).
 *
 * A single row by application invariant. Credential changes update that row in
 * place, including when the username changes.
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

/**
 * The operator account, for the paths that need "the" educator rather than a
 * named one: the first-run wizard's resume derivation, and the session it issues
 * when setup finishes (PRD §6.2, §7).
 *
 * Ordered rather than merely first-found, so corrupted legacy state is handled
 * deterministically while recovery refuses to mutate it.
 */
export function getFirstEducator(db: AppDatabase): Educator | undefined {
  return db.select().from(educator).orderBy(asc(educator.createdAt)).get();
}

/**
 * Replace an existing account's username and hash, in place.
 *
 * Distinct from `createEducator`, which keys on the username and would insert a
 * *second* account if the wizard's operator went back a step and changed it.
 * Setun has one educator account (§7); editing the row is what keeps that true.
 */
export function updateEducatorCredential(
  db: AppDatabase,
  input: { educatorId: string; username: string; passwordHash: string },
): Educator | undefined {
  const [row] = db
    .update(educator)
    .set({ username: input.username, passwordHash: input.passwordHash, updatedAt: new Date() })
    .where(eq(educator.id, input.educatorId))
    .returning()
    .all();
  return row;
}
