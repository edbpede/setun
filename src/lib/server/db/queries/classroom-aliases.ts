import { and, eq } from "drizzle-orm";
import type { AppDatabase } from "../client";
import { classroomModelAlias, type ModelAlias, modelAlias } from "../schema";

/**
 * The classroom model allowlist (PRD §8, §9, §21).
 *
 * An absent row is a denial. Nothing here answers "may this student use this
 * alias?" from anything the client sent — the classroom comes from the resolved
 * session, and the alias from the conversation's own row.
 *
 * Availability is folded into the read side: an alias the educator has taken
 * out of service is unusable everywhere at once, without every caller
 * remembering to check both.
 */

/** Aliases this classroom may use, and that are currently available (§9). */
export function listClassroomAliases(db: AppDatabase, classroomId: string): ModelAlias[] {
  return db
    .select({ alias: modelAlias })
    .from(classroomModelAlias)
    .innerJoin(modelAlias, eq(modelAlias.id, classroomModelAlias.modelAliasId))
    .where(and(eq(classroomModelAlias.classroomId, classroomId), eq(modelAlias.available, true)))
    .all()
    .map((row) => row.alias);
}

/**
 * Whether one alias is allowlisted for one classroom and available.
 *
 * The single question `enforcement` asks before a request can reach a model.
 */
export function isAliasAllowed(
  db: AppDatabase,
  input: { classroomId: string; modelAliasId: string },
): boolean {
  const row = db
    .select({ id: modelAlias.id })
    .from(classroomModelAlias)
    .innerJoin(modelAlias, eq(modelAlias.id, classroomModelAlias.modelAliasId))
    .where(
      and(
        eq(classroomModelAlias.classroomId, input.classroomId),
        eq(classroomModelAlias.modelAliasId, input.modelAliasId),
        eq(modelAlias.available, true),
      ),
    )
    .get();

  return row !== undefined;
}

/**
 * Add an alias to a classroom's allowlist.
 *
 * `noDpaConfirmedAt` records the educator's explicit confirmation for an alias
 * without a data processing agreement — §16 requires that decision be made
 * deliberately and per classroom, which means it has to be recorded, not merely
 * displayed in a dialog and forgotten.
 */
export function allowAlias(
  db: AppDatabase,
  input: { classroomId: string; modelAliasId: string; noDpaConfirmedAt?: Date | null },
): void {
  db.insert(classroomModelAlias)
    .values({
      classroomId: input.classroomId,
      modelAliasId: input.modelAliasId,
      noDpaConfirmedAt: input.noDpaConfirmedAt ?? null,
    })
    .onConflictDoUpdate({
      target: [classroomModelAlias.classroomId, classroomModelAlias.modelAliasId],
      set: { noDpaConfirmedAt: input.noDpaConfirmedAt ?? null },
    })
    .run();
}

export function disallowAlias(
  db: AppDatabase,
  input: { classroomId: string; modelAliasId: string },
): void {
  db.delete(classroomModelAlias)
    .where(
      and(
        eq(classroomModelAlias.classroomId, input.classroomId),
        eq(classroomModelAlias.modelAliasId, input.modelAliasId),
      ),
    )
    .run();
}

/** Allowlisted alias ids, including unavailable ones — the panel edits the set itself. */
export function listAllowedAliasIds(db: AppDatabase, classroomId: string): string[] {
  return db
    .select({ modelAliasId: classroomModelAlias.modelAliasId })
    .from(classroomModelAlias)
    .where(eq(classroomModelAlias.classroomId, classroomId))
    .all()
    .map((row) => row.modelAliasId);
}
