import { eq, inArray, ne } from "drizzle-orm";
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

/**
 * Several aliases by id, keyed for lookup.
 *
 * The cost estimate prices a day's usage rows, which name aliases rather than
 * carry prices; one query rather than one per row.
 */
export function listAliasesByIds(
  db: AppDatabase,
  aliasIds: readonly string[],
): Map<string, ModelAlias> {
  if (aliasIds.length === 0) return new Map();

  const rows = db
    .select()
    .from(modelAlias)
    .where(inArray(modelAlias.id, [...aliasIds]))
    .all();

  return new Map(rows.map((row) => [row.id, row]));
}

/** Every alias, in service or not — the panel edits the set itself (§17). */
export function listAliases(db: AppDatabase): ModelAlias[] {
  return db.select().from(modelAlias).all();
}

export type AliasUpdate = Partial<Omit<typeof modelAlias.$inferInsert, "id" | "createdAt">>;

export function updateAlias(
  db: AppDatabase,
  input: { aliasId: string; values: AliasUpdate },
): ModelAlias | undefined {
  const [row] = db
    .update(modelAlias)
    .set({ ...input.values, updatedAt: new Date() })
    .where(eq(modelAlias.id, input.aliasId))
    .returning()
    .all();
  return row;
}

/**
 * Delete an alias.
 *
 * Allowlist rows cascade with it; conversations keep their `modelAliasId`, and
 * enforcement then refuses them as not-allowlisted rather than crashing — the
 * safe direction (§8, §21).
 */
export function deleteAlias(db: AppDatabase, aliasId: string): void {
  db.delete(modelAlias).where(eq(modelAlias.id, aliasId)).run();
}

/**
 * Make one alias the utility alias, clearing any other (§9, §10).
 *
 * "One alias is designated the utility alias" — singular, so designating a new
 * one has to clear the old, and doing it in a transaction keeps the table from
 * ever holding two.
 */
export function designateUtilityAlias(db: AppDatabase, aliasId: string): void {
  db.transaction((tx) => {
    tx.update(modelAlias)
      .set({ isUtility: false, updatedAt: new Date() })
      .where(ne(modelAlias.id, aliasId))
      .run();
    tx.update(modelAlias)
      .set({ isUtility: true, updatedAt: new Date() })
      .where(eq(modelAlias.id, aliasId))
      .run();
  });
}
