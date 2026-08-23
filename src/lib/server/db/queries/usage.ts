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
