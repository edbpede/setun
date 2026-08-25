import { budgetDayRange } from "../agent/budgets";
import type { AppDatabase } from "../db/client";
import { listClassrooms } from "../db/queries/classrooms";
import { listAliasesByIds } from "../db/queries/model-aliases";
import { lastActivityByStudent, listClassroomStudents } from "../db/queries/students";
import { classroomDailyConsumption, classroomUsageByStudent } from "../db/queries/usage";
import type { Classroom, ClassroomState } from "../db/schema";
import { estimateUsageCost } from "./cost-estimate";
import { type AvailabilityStatus, resolveAvailability } from "./schedule";

/**
 * The panel's dashboard row for one classroom (PRD §17).
 *
 * "Dashboard: classroom state, active students, gateway health, current window,
 * usage against budgets and caps, and a one-click lock."
 *
 * Gateway health is not here because it is a property of the deployment rather
 * than of a classroom, and the panel asks for it once (§9). Everything else is
 * per classroom, and everything else is a counter — nothing a pupil wrote
 * reaches this shape, because §16 gives the educator no interface for that.
 */

/** How recently a pupil must have been seen to count as active in the lesson. */
export const ACTIVE_WINDOW_MINUTES = 15;

export interface ClassroomOverview {
  readonly id: string;
  readonly name: string;
  readonly timezone: string;
  readonly state: ClassroomState;
  readonly availability: AvailabilityStatus;
  readonly studentCount: number;
  /** Seen inside the active window — who is in the lesson right now (§17). */
  readonly activeStudents: number;
  readonly usedTokens: number;
  readonly capTokens: number;
  readonly capExhausted: boolean;
  /** Display-only, null where no alias used today carries a price (§10). */
  readonly costUsd: number | null;
  readonly costDkk: number | null;
}

export function resolveClassroomOverview(
  db: AppDatabase,
  classroom: Classroom,
  now: Date = new Date(),
): ClassroomOverview {
  const range = budgetDayRange(classroom.timezone, now);
  const students = listClassroomStudents(db, classroom.id);

  const lastActivity = lastActivityByStudent(
    db,
    students.map((student) => student.id),
  );
  const activeSince = now.getTime() - ACTIVE_WINDOW_MINUTES * 60 * 1000;

  // Includes utility work, which counts against the classroom cap and never a
  // pupil's allowance (§10) — so the figure shown beside the cap must include it.
  const usedTokens = classroomDailyConsumption(db, {
    classroomId: classroom.id,
    from: range.start,
    until: range.end,
  });

  const usage = classroomUsageByStudent(db, {
    classroomId: classroom.id,
    from: range.start,
    until: range.end,
  });
  const aliases = listAliasesByIds(
    db,
    usage.map((row) => row.modelAliasId),
  );
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
    id: classroom.id,
    name: classroom.name,
    timezone: classroom.timezone,
    state: classroom.state,
    availability: resolveAvailability(classroom, now),
    studentCount: students.length,
    activeStudents: students.filter((student) => {
      const seen = lastActivity.get(student.id);
      return student.status === "active" && seen !== undefined && seen.getTime() >= activeSince;
    }).length,
    usedTokens,
    capTokens: classroom.perClassroomDailyTokens,
    capExhausted: usedTokens >= classroom.perClassroomDailyTokens,
    costUsd: cost.usd,
    costDkk: cost.dkk,
  };
}

/** Every classroom, for the dashboard. Open rooms first — that is what a lesson needs. */
export function resolveDashboard(db: AppDatabase, now: Date = new Date()): ClassroomOverview[] {
  return listClassrooms(db)
    .map((classroom) => resolveClassroomOverview(db, classroom, now))
    .sort((a, b) => {
      if (a.availability.open !== b.availability.open) return a.availability.open ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
}
