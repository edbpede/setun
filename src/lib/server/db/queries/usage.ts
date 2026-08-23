import { and, eq, gte, isNotNull, lt, sql } from "drizzle-orm";
import type { AppDatabase } from "../client";
import { type UsageEvent, usageEvent } from "../schema";

/**
 * Usage accounting rows (PRD §10, §19).
 *
 * Written from the first turn onward; read and enforced against budgets in
 * Phase 2.7. Two invariants hold here already:
 *
 * - usage is never recorded as zero for a response that produced text — the
 *   caller estimates when the gateway reports nothing, and flags it;
 * - internal utility work records a null student, so it counts against the
 *   classroom cap only and never a student's personal allowance.
 */
export function recordUsageEvent(
  db: AppDatabase,
  input: {
    classroomId: string;
    studentId: string | null;
    modelAliasId: string;
    inputTokens: number;
    outputTokens: number;
    toolCalls?: number;
    estimated: boolean;
  },
): UsageEvent {
  const [row] = db
    .insert(usageEvent)
    .values({
      classroomId: input.classroomId,
      studentId: input.studentId,
      modelAliasId: input.modelAliasId,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      toolCalls: input.toolCalls ?? 0,
      estimated: input.estimated,
    })
    .returning()
    .all();
  return row;
}

/**
 * Tokens consumed today by one student and by their classroom (PRD §10).
 *
 * Both axes in one round trip, because the enforcement point always needs both
 * — checking only the student budget when the classroom cap is exhausted would
 * tell one pupil they may proceed even though the class has nothing left.
 */
export function dailyConsumption(
  db: AppDatabase,
  input: { classroomId: string; studentId: string; from: Date; until: Date },
): { studentTokens: number; classroomTokens: number } {
  const rows = db
    .select({
      studentTokens: sql<number>`coalesce(sum(case when ${usageEvent.studentId} = ${input.studentId} then ${usageEvent.inputTokens} + ${usageEvent.outputTokens} else 0 end), 0)`,
      classroomTokens: sql<number>`coalesce(sum(${usageEvent.inputTokens} + ${usageEvent.outputTokens}), 0)`,
    })
    .from(usageEvent)
    .where(
      and(
        eq(usageEvent.classroomId, input.classroomId),
        gte(usageEvent.createdAt, input.from),
        lt(usageEvent.createdAt, input.until),
      ),
    )
    .all();

  return rows[0] ?? { studentTokens: 0, classroomTokens: 0 };
}

/**
 * Total tokens consumed today for the whole classroom, including utility work.
 *
 * Used when deciding whether to skip utility work (§10).
 */
export function classroomDailyConsumption(
  db: AppDatabase,
  input: { classroomId: string; from: Date; until: Date },
): number {
  const [row] = db
    .select({
      total: sql<number>`coalesce(sum(${usageEvent.inputTokens} + ${usageEvent.outputTokens}), 0)`,
    })
    .from(usageEvent)
    .where(
      and(
        eq(usageEvent.classroomId, input.classroomId),
        gte(usageEvent.createdAt, input.from),
        lt(usageEvent.createdAt, input.until),
      ),
    )
    .all();

  return row?.total ?? 0;
}

/**
 * One student's usage today, grouped by alias (PRD §10).
 *
 * Grouped rather than totalled because the cost estimate is per-alias: prices
 * differ between aliases, and a single token total cannot be priced. Enforcement
 * never reads this — it is denominated in tokens and asks `dailyConsumption`.
 */
export function dailyUsageByAlias(
  db: AppDatabase,
  input: { classroomId: string; studentId: string; from: Date; until: Date },
): { modelAliasId: string; inputTokens: number; outputTokens: number }[] {
  return db
    .select({
      modelAliasId: usageEvent.modelAliasId,
      inputTokens: sql<number>`coalesce(sum(${usageEvent.inputTokens}), 0)`,
      outputTokens: sql<number>`coalesce(sum(${usageEvent.outputTokens}), 0)`,
    })
    .from(usageEvent)
    .where(
      and(
        eq(usageEvent.classroomId, input.classroomId),
        eq(usageEvent.studentId, input.studentId),
        gte(usageEvent.createdAt, input.from),
        lt(usageEvent.createdAt, input.until),
      ),
    )
    .groupBy(usageEvent.modelAliasId)
    .all();
}

/**
 * A classroom's usage today, per student and per alias (PRD §10, §17).
 *
 * "Roster: per-student status, usage and allowance (with cost estimate)" (§17).
 * Grouped by both axes because the roster shows tokens *and* a priced estimate,
 * and prices differ between aliases — one total per student could not be priced.
 *
 * Utility rows carry a null student and are excluded: they belong to the class,
 * never to a pupil's allowance (§10).
 */
export function classroomUsageByStudent(
  db: AppDatabase,
  input: { classroomId: string; from: Date; until: Date },
): { studentId: string; modelAliasId: string; inputTokens: number; outputTokens: number }[] {
  return db
    .select({
      studentId: sql<string>`${usageEvent.studentId}`,
      modelAliasId: usageEvent.modelAliasId,
      inputTokens: sql<number>`coalesce(sum(${usageEvent.inputTokens}), 0)`,
      outputTokens: sql<number>`coalesce(sum(${usageEvent.outputTokens}), 0)`,
    })
    .from(usageEvent)
    .where(
      and(
        eq(usageEvent.classroomId, input.classroomId),
        isNotNull(usageEvent.studentId),
        gte(usageEvent.createdAt, input.from),
        lt(usageEvent.createdAt, input.until),
      ),
    )
    .groupBy(usageEvent.studentId, usageEvent.modelAliasId)
    .all();
}
