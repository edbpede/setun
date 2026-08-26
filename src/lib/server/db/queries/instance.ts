import { and, eq, isNotNull, isNull, lt, or } from "drizzle-orm";
import type { AppDatabase } from "../client";
import { INSTANCE_ID, type Instance, instance } from "../schema";

/**
 * The installation row (PRD §6.2, §7).
 *
 * Every write here is conditional on the state it expects to find, rather than
 * a read followed by a write. SQLite serialises writers, so the race is benign
 * in this deployment — but a claim is an exclusion, and an exclusion expressed
 * as `SELECT` then `UPDATE` is only correct by accident. Expressed as one
 * statement it is correct by construction, and "did I win?" is answered by the
 * row count rather than by a second read that could see somebody else's win.
 *
 * No function here handles a plaintext claim proof; the digest arrives already
 * computed, exactly as the session table's does (§21).
 */

/** Read the row, creating it if this installation has never written one. */
export function ensureInstance(db: AppDatabase): Instance {
  db.insert(instance).values({ id: INSTANCE_ID }).onConflictDoNothing().run();

  const row = db.select().from(instance).where(eq(instance.id, INSTANCE_ID)).get();
  if (!row) throw new Error("the instance row could not be created");
  return row;
}

/** Read the row without creating it. Undefined on an installation that has never booted. */
export function readInstance(db: AppDatabase): Instance | undefined {
  return db.select().from(instance).where(eq(instance.id, INSTANCE_ID)).get();
}

/**
 * Take the claim, if it is free or stale.
 *
 * True when this call won it. The condition is the whole exclusion: setup must
 * still be incomplete, and the existing claim must be absent or older than the
 * caller's cutoff. Two browsers racing produce one winner and one `false`, and
 * nothing in between.
 *
 * `setupStartedAt` is stamped by the first winner and never moved afterwards —
 * it is what tells a later boot that a wizard has been started here, so
 * adoption must not run.
 */
export function takeClaim(
  db: AppDatabase,
  input: { proofDigest: string; now: Date; staleBefore: Date },
): boolean {
  const existing = readInstance(db);

  const rows = db
    .update(instance)
    .set({
      claimProofDigest: input.proofDigest,
      claimedAt: input.now,
      setupStartedAt: existing?.setupStartedAt ?? input.now,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(instance.id, INSTANCE_ID),
        isNull(instance.setupCompletedAt),
        or(
          isNull(instance.claimProofDigest),
          isNull(instance.claimedAt),
          lt(instance.claimedAt, input.staleBefore),
        ),
      ),
    )
    .returning({ id: instance.id })
    .all();

  return rows.length === 1;
}

/**
 * Take the claim outright, whatever its state.
 *
 * The recovery path only: an educator credential is strictly stronger proof
 * than holding a cookie, so a browser that presents one takes ownership rather
 * than waiting ten minutes for an abandoned tab to lapse. `takeClaim` stays
 * conditional precisely because a bootstrap token is *not* stronger — two people
 * reading the same console banner are equally entitled, and first-come is the
 * only fair rule there.
 */
export function seizeClaim(db: AppDatabase, input: { proofDigest: string; now: Date }): boolean {
  const existing = readInstance(db);

  const rows = db
    .update(instance)
    .set({
      claimProofDigest: input.proofDigest,
      claimedAt: input.now,
      setupStartedAt: existing?.setupStartedAt ?? input.now,
      updatedAt: input.now,
    })
    .where(and(eq(instance.id, INSTANCE_ID), isNull(instance.setupCompletedAt)))
    .returning({ id: instance.id })
    .all();

  return rows.length === 1;
}

/**
 * Slide an existing claim forward.
 *
 * The digest is *not* part of the condition: the caller has already compared it
 * in constant time, and putting it in a `WHERE` would compare it again in
 * SQLite's own time (§21).
 */
export function renewClaim(db: AppDatabase, now: Date): void {
  db.update(instance)
    .set({ claimedAt: now, updatedAt: now })
    .where(and(eq(instance.id, INSTANCE_ID), isNull(instance.setupCompletedAt)))
    .run();
}

/** Release the claim without finishing setup — an explicit hand-back. */
export function releaseClaim(db: AppDatabase, now: Date): void {
  db.update(instance)
    .set({ claimProofDigest: null, claimedAt: null, updatedAt: now })
    .where(eq(instance.id, INSTANCE_ID))
    .run();
}

/**
 * Finish setup, releasing the claim in the same statement.
 *
 * One write rather than two: a process that died between them would leave a
 * completed installation still holding a claim nobody can release, and the gate
 * would be open while `/setup` still believed it had an owner.
 */
export function completeSetup(db: AppDatabase, now: Date): void {
  db.update(instance)
    .set({
      setupCompletedAt: now,
      claimProofDigest: null,
      claimedAt: null,
      updatedAt: now,
    })
    .where(and(eq(instance.id, INSTANCE_ID), isNull(instance.setupCompletedAt)))
    .run();
}

/**
 * Mark setup complete for an installation that predates the wizard.
 *
 * Conditional on *both* timestamps being null, which is the whole safety
 * property: an install whose wizard has been claimed has a `setupStartedAt`, so
 * it can never be adopted out from under a half-finished setup. Returns true
 * only when this call performed the adoption, so the caller logs one line rather
 * than one per boot.
 */
export function adoptSetup(db: AppDatabase, now: Date): boolean {
  const rows = db
    .update(instance)
    .set({ setupCompletedAt: now, updatedAt: now })
    .where(
      and(
        eq(instance.id, INSTANCE_ID),
        isNull(instance.setupCompletedAt),
        isNull(instance.setupStartedAt),
      ),
    )
    .returning({ id: instance.id })
    .all();

  return rows.length === 1;
}

/**
 * Undo an adoption that turned out to be premature.
 *
 * The mirror of `adoptSetup`, and conditional on the same `setupStartedAt IS
 * NULL`, so it can never reopen an installation a browser has actually claimed
 * or a wizard has actually finished. `setupCompletedAt IS NOT NULL` keeps the
 * return value honest: true means this call reopened something.
 *
 * The one caller is boot's seed-failure path — an installation adopted on the
 * strength of *configured* seed credentials whose seed then failed has no
 * operator account, and recording it as complete would be recording something
 * untrue.
 */
export function reopenSetup(db: AppDatabase, now: Date): boolean {
  const rows = db
    .update(instance)
    .set({ setupCompletedAt: null, updatedAt: now })
    .where(
      and(
        eq(instance.id, INSTANCE_ID),
        isNotNull(instance.setupCompletedAt),
        isNull(instance.setupStartedAt),
      ),
    )
    .returning({ id: instance.id })
    .all();

  return rows.length === 1;
}
