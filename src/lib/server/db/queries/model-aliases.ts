import { eq } from "drizzle-orm";
import type { AppDatabase } from "../client";
import { type ModelAlias, modelAlias } from "../schema";

/**
 * The model alias table (PRD §9).
 *
 * The dialect lives here and is read only by the gateway adapter; nothing above
 * it branches on which dialect an alias selected (§9).
 *
 * Aliases are managed in the educator panel from Phase 2.6 — until then the dev
 * seed writes them.
 */

export function listAvailableAliases(db: AppDatabase): ModelAlias[] {
  return db.select().from(modelAlias).where(eq(modelAlias.available, true)).all();
}

export function getAliasById(db: AppDatabase, aliasId: string): ModelAlias | undefined {
  return db.select().from(modelAlias).where(eq(modelAlias.id, aliasId)).get();
}

export function getAliasByName(db: AppDatabase, name: string): ModelAlias | undefined {
  return db.select().from(modelAlias).where(eq(modelAlias.name, name)).get();
}

/**
 * The alias internal work runs on — today, title generation (§10).
 *
 * Returns undefined when none is designated, which is a supported state: the
 * caller falls back rather than failing the student's turn.
 */
export function getUtilityAlias(db: AppDatabase): ModelAlias | undefined {
  return db.select().from(modelAlias).where(eq(modelAlias.isUtility, true)).get();
}

export function createAlias(db: AppDatabase, input: typeof modelAlias.$inferInsert): ModelAlias {
  const [row] = db.insert(modelAlias).values(input).returning().all();
  return row;
}
