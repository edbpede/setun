import { budgetDayRange } from "../agent/budgets";
import type { AppDatabase } from "../db/client";
import { listAliasesByIds } from "../db/queries/model-aliases";
import { lastActivityByStudent, listClassroomStudents } from "../db/queries/students";
import { classroomUsageByStudent } from "../db/queries/usage";
import type { Classroom, StudentStatus } from "../db/schema";
import { estimateUsageCost } from "./cost-estimate";

/**
 * The educator's roster view (PRD §16, §17).
 *
 * "Roster: per-student status, usage and allowance (with cost estimate), last
 * activity, per-student instructions…"
 *
 * And, as firmly, what it does *not* carry: nothing a pupil wrote. "Educators
 * have no interface for reading student conversations — the pilot deliberately
 * omits one" (§16). What comes back here is account state, counters and the
 * educator's own text.
 *
 * The costs are display-only. Enforcement is denominated in tokens and never
 * depends on a price being present or current (§10).
 */

export interface RosterEntry {
  readonly id: string;
  readonly label: string;
  /** Optional, pupil-set, and clearable from the panel (§16, §17). */
  readonly displayName: string | null;
  readonly status: StudentStatus;
  /** Educator-authored, not pupil-authored (§10). */
  readonly instructions: string | null;
  /** The override; null means this pupil follows the classroom setting (§10, §17). */
  readonly attachmentsOverride: boolean | null;
  /** What the two settings resolve to for this pupil right now. */
  readonly attachmentsEffective: boolean;
  /** Non-secret tail of the access code, so a printed card can be identified (§7). */
  readonly credentialHint: string;
  /** Null for a pupil who has never signed in (§17). */
  readonly lastActivityAt: Date | null;
  readonly usedTokens: number;
  readonly limitTokens: number;
  readonly exhausted: boolean;
  /** Null where no alias the pupil used carries a price (§10). */
  readonly costUsd: number | null;
  readonly costDkk: number | null;
}

/** One classroom's roster with today's usage against the daily allowance. */
export function resolveRoster(
  db: AppDatabase,
  classroom: Classroom,
  now: Date = new Date(),
  options: { includeRemoved?: boolean } = {},
): RosterEntry[] {
  const range = budgetDayRange(classroom.timezone, now);
  const rows = classroomUsageByStudent(db, {
    classroomId: classroom.id,
    from: range.start,
    until: range.end,
  });

  const aliases = listAliasesByIds(
    db,
    rows.map((row) => row.modelAliasId),
  );

  const byStudent = new Map<string, typeof rows>();
  for (const row of rows) {
    const existing = byStudent.get(row.studentId);
    if (existing) existing.push(row);
    else byStudent.set(row.studentId, [row]);
  }

  const students = listClassroomStudents(db, classroom.id, options);
  const lastActivity = lastActivityByStudent(
    db,
    students.map((student) => student.id),
  );

  return students.map((student) => {
    const usage = byStudent.get(student.id) ?? [];
    const usedTokens = usage.reduce((sum, row) => sum + row.inputTokens + row.outputTokens, 0);

    const cost = estimateUsageCost(
      usage.map((row) => {
        const alias = aliases.get(row.modelAliasId);
        return {
          inputTokens: row.inputTokens,
          outputTokens: row.outputTokens,
          inputPricePerMillion: alias?.inputPricePerMillion ?? null,
          outputPricePerMillion: alias?.outputPricePerMillion ?? null,
        };
      }),
      classroom.costExchangeRate,
    );

    return {
      id: student.id,
      label: student.label,
      displayName: student.displayName,
      status: student.status,
      instructions: student.instructions,
      attachmentsOverride: student.attachmentsEnabled,
      attachmentsEffective: student.attachmentsEnabled ?? classroom.attachmentsEnabled,
      credentialHint: student.credentialHint,
      lastActivityAt: lastActivity.get(student.id) ?? null,
      usedTokens,
      limitTokens: classroom.perStudentDailyTokens,
      exhausted: usedTokens >= classroom.perStudentDailyTokens,
      costUsd: cost.usd,
      costDkk: cost.dkk,
    };
  });
}
