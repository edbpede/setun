import { budgetDayRange } from "../agent/budgets";
import type { AppDatabase } from "../db/client";
import { getClassroom } from "../db/queries/classrooms";
import { listAliasesByIds } from "../db/queries/model-aliases";
import { dailyConsumption, dailyUsageByAlias } from "../db/queries/usage";
import type { Student } from "../db/schema";
import { estimateUsageCost } from "./cost-estimate";
import { resolveAvailability } from "./schedule";

/**
 * The student-facing view of their classroom (PRD §8, §10, §18).
 *
 * One shape, three consumers: the chat route's load, the closed status screen,
 * and the classroom-state push channel (§6). They agree because they call this,
 * not because three call sites were kept in step by hand.
 *
 * Everything here is presentation. Enforcement lives in `enforcement.ts` and
 * never reads this — a client that never receives a status, or receives a stale
 * one, is refused by the guard all the same (§8, §21).
 *
 * Instants are ISO strings because this crosses to the browser both in a load's
 * payload and as SSE JSON, and a `Date` survives neither intact.
 */

export interface AllowanceStatus {
  readonly usedTokens: number;
  readonly limitTokens: number;
  readonly remainingTokens: number;
  readonly exhausted: boolean;
  /** True when the whole class has reached its ceiling — a different message (§10). */
  readonly classroomExhausted: boolean;
  /** Display-only, null when no allowlisted alias carries a price (§10). */
  readonly costUsd: number | null;
  readonly costDkk: number | null;
}

export interface ClassroomStatus {
  readonly open: boolean;
  /**
   * The classroom's IANA zone, so the closed screen names the next opening in
   * the room's own time rather than the device's — school Chromebooks are not
   * reliably configured, and "Monday 09:00" must mean the lesson (§8).
   */
  readonly timezone: string;
  readonly reason: "explicit-open" | "explicit-lock" | "scheduled" | "outside-schedule";
  readonly nextOpeningAt: string | null;
  readonly opensUntil: string | null;
  readonly allowance: AllowanceStatus;
}

/** The status a classroom that has vanished presents: closed, with nothing to promise. */
const ABSENT: ClassroomStatus = {
  open: false,
  timezone: "Europe/Copenhagen",
  reason: "outside-schedule",
  nextOpeningAt: null,
  opensUntil: null,
  allowance: {
    usedTokens: 0,
    limitTokens: 0,
    remainingTokens: 0,
    exhausted: true,
    classroomExhausted: true,
    costUsd: null,
    costDkk: null,
  },
};

/** Resolve availability and today's allowance for one student. */
export function resolveClassroomStatus(
  db: AppDatabase,
  student: Student,
  now: Date = new Date(),
): ClassroomStatus {
  const classroom = getClassroom(db, student.classroomId);
  if (!classroom) return ABSENT;

  const availability = resolveAvailability(classroom, now);
  const range = budgetDayRange(classroom.timezone, now);

  const consumed = dailyConsumption(db, {
    classroomId: classroom.id,
    studentId: student.id,
    from: range.start,
    until: range.end,
  });

  const usageRows = dailyUsageByAlias(db, {
    classroomId: classroom.id,
    studentId: student.id,
    from: range.start,
    until: range.end,
  });
  const aliases = listAliasesByIds(
    db,
    usageRows.map((row) => row.modelAliasId),
  );
  const cost = estimateUsageCost(
    usageRows.map((row) => {
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
    open: availability.open,
    timezone: classroom.timezone,
    reason: availability.reason,
    nextOpeningAt: availability.nextOpeningAt?.toISOString() ?? null,
    opensUntil: availability.opensUntil?.toISOString() ?? null,
    allowance: {
      usedTokens: consumed.studentTokens,
      limitTokens: classroom.perStudentDailyTokens,
      remainingTokens: Math.max(0, classroom.perStudentDailyTokens - consumed.studentTokens),
      exhausted: consumed.studentTokens >= classroom.perStudentDailyTokens,
      classroomExhausted: consumed.classroomTokens >= classroom.perClassroomDailyTokens,
      costUsd: cost.usd,
      costDkk: cost.dkk,
    },
  };
}

/**
 * A cheap identity for a status, so the push channel can skip unchanged ticks.
 *
 * Token counts are deliberately included: a student watching their allowance
 * drain should see it move, and the figure changes only when a turn finishes.
 */
export function statusFingerprint(status: ClassroomStatus): string {
  return [
    status.open,
    status.reason,
    status.nextOpeningAt,
    status.opensUntil,
    status.allowance.usedTokens,
    status.allowance.limitTokens,
    status.allowance.classroomExhausted,
  ].join("|");
}
