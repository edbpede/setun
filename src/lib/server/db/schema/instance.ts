import { sql } from "drizzle-orm";
import { check, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { createdAt, updatedAt } from "./helpers";

/**
 * The installation itself (PRD §6.2, §7).
 *
 * One row, always. It records the two facts that decide whether a cold install
 * is still being set up: when the first-run wizard was claimed, and when it
 * finished. Everything else about a deployment lives in the environment or in
 * the classroom; this table exists because a *flag* has to survive a restart and
 * the environment cannot hold one the application writes.
 *
 * Typed columns rather than a key/value bag: a `setting` table with a `value`
 * column would make every read a parse and every write a stringify, and would
 * lose the one thing SQLite is good at here — a nullable timestamp meaning "not
 * yet".
 *
 * `primaryId()` is deliberately not used. Its random UUID is right for a row
 * that is one of many and wrong for a row that must be the only one: the id is
 * a fixed literal, and the check constraint makes a second row a database error
 * rather than a silently divergent second opinion about whether setup is done.
 */

/** The only id this table ever holds. */
export const INSTANCE_ID = "setun";

export const instance = sqliteTable(
  "instance",
  {
    id: text().primaryKey().notNull().default(INSTANCE_ID),

    /**
     * When the first-run wizard was first claimed (§6.2).
     *
     * Null means no browser has ever started setup — which is what the boot-time
     * adoption rule tests before it decides an existing install needs no wizard.
     * Once it is set, adoption never runs again, so a half-finished wizard is
     * never mistaken for a finished installation.
     */
    setupStartedAt: integer({ mode: "timestamp_ms" }),

    /**
     * When setup finished. The one flag the request gate reads.
     *
     * Written by the wizard's finish action and by boot-time adoption, and by
     * nothing else: opening the gate before a model alias and a classroom exist
     * would hand the educator a panel that cannot serve a lesson.
     */
    setupCompletedAt: integer({ mode: "timestamp_ms" }),

    /**
     * SHA-256 of the claim proof held by the browser that owns the in-progress
     * setup (§7, §21).
     *
     * The digest convention the session table already uses: the plaintext lives
     * only in that browser's cookie, so a database read cannot mint a claim.
     */
    claimProofDigest: text(),
    /** When the claim was last renewed. Slides on every guarded step. */
    claimedAt: integer({ mode: "timestamp_ms" }),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [check("instance_singleton", sql`${t.id} = 'setun'`)],
);

export type Instance = typeof instance.$inferSelect;
