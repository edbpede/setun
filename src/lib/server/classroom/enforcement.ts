import {
  type BudgetRefusal,
  budgetDayRange,
  budgetsOf,
  checkTurnBudget,
  type DailyConsumption,
} from "../agent/budgets";
import type { AppDatabase } from "../db/client";
import { isAliasAllowed } from "../db/queries/classroom-aliases";
import { getClassroom } from "../db/queries/classrooms";
import { dailyConsumption } from "../db/queries/usage";
import type { Classroom, Student } from "../db/schema";
import { type AvailabilityStatus, resolveAvailability } from "./schedule";

/**
 * Server-side enforcement (PRD §8, §10, §21).
 *
 * "Enforcement is server-side and applies to every path that can reach a model —
 * chat, tool execution, image generation, and any API endpoint. Hiding a control
 * in the UI is never treated as access control."
 *
 * One guard, one call, on every request. The outcome is a discriminated union
 * so the route can tell the client *what* failed in friendly terms — but the
 * code is machine-readable, and the client maps it to a Paraglide message
 * rather than forwarding a server string (§21).
 */

export type EnforcementResult =
  | {
      readonly allowed: true;
      /**
       * The classroom the decision was made against.
       *
       * Returned rather than re-read by the caller: the send path needs its
       * instructions and its budgets for the very turn just authorised, and
       * fetching it twice would let the two reads disagree.
       */
      readonly classroom: Classroom;
      readonly availability: AvailabilityStatus;
      /**
       * What the classroom and this pupil have spent today, as of this check.
       *
       * Returned rather than re-read: the loop needs it to bind the daily
       * ceilings *during* the turn this call just authorised, and the figures
       * were already computed to authorise it (§10).
       */
      readonly consumed: DailyConsumption;
    }
  | {
      readonly allowed: false;
      readonly reason: EnforcementRefusal;
      readonly availability: AvailabilityStatus;
    };

export type EnforcementRefusal =
  | "classroom-not-found"
  | "classroom-locked"
  | "outside-schedule"
  | "model-not-allowed"
  | BudgetRefusal;

export interface CheckAccessInput {
  readonly db: AppDatabase;
  readonly student: Student;
  /** The alias the conversation uses — not a user-submitted value. */
  readonly modelAliasId: string;
  readonly now?: Date;
}

/**
 * May this student start a turn against this alias, right now?
 *
 * Checked on every send. A streaming response already in flight when the
 * classroom locks may finish — only new requests are refused (§8).
 */
export function checkModelAccess(input: CheckAccessInput): EnforcementResult {
  const { db, student, modelAliasId } = input;
  const now = input.now ?? new Date();

  const classroom = getClassroom(db, student.classroomId);
  if (!classroom) {
    return denied("classroom-not-found", dummyAvailability());
  }

  const availability = resolveAvailability(classroom, now);

  if (!availability.open) {
    return denied(availabilityRefusal(availability), availability);
  }

  if (!isAliasAllowed(db, { classroomId: classroom.id, modelAliasId })) {
    return denied("model-not-allowed", availability);
  }

  const range = budgetDayRange(classroom.timezone, now);
  const consumed = dailyConsumption(db, {
    classroomId: classroom.id,
    studentId: student.id,
    from: range.start,
    until: range.end,
  });
  const budget = checkTurnBudget(budgetsOf(classroom), consumed);
  if (!budget.allowed) {
    return denied(budget.refusal, availability);
  }

  return { allowed: true, classroom, availability, consumed };
}

/**
 * Which refusal a closed classroom is, in the client's vocabulary.
 *
 * Shared so the send path and the two conversation-creation paths cannot drift
 * into describing the same closed room differently (§8, §21).
 */
export function availabilityRefusal(availability: AvailabilityStatus): EnforcementRefusal {
  return availability.reason === "explicit-lock" ? "classroom-locked" : "outside-schedule";
}

function denied(reason: EnforcementRefusal, availability: AvailabilityStatus): EnforcementResult {
  return { allowed: false, reason, availability };
}

function dummyAvailability(): AvailabilityStatus {
  return { open: false, reason: "outside-schedule", nextOpeningAt: null, opensUntil: null };
}

/**
 * Resolve the availability alone, without a model or budget check.
 *
 * The push channel and the closed screen need the status but have no alias and
 * no budget context.
 */
export function classroomAvailability(
  db: AppDatabase,
  classroomId: string,
  now: Date = new Date(),
): AvailabilityStatus | null {
  const classroom = getClassroom(db, classroomId);
  return classroom ? resolveAvailability(classroom, now) : null;
}
