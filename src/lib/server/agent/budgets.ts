import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import type { Classroom } from "../db/schema";

/**
 * The three budget layers (PRD §10).
 *
 * "Budgets are three layers, all denominated in tokens — the unit the gateway
 * actually reports — and all panel-configurable per classroom."
 *
 *  1. Per-turn caps — steps, wall-clock, tokens. These stop a runaway loop.
 *  2. Per-student daily allowance — so one pupil cannot drain the class.
 *  3. Per-classroom daily cap — the ceiling for the whole class.
 *
 * Layers 2 and 3 are checked when a turn starts; layer 1 bounds a turn already
 * running. "A turn already streaming completes within its per-turn caps even if
 * an allowance empties mid-turn — the per-turn layer bounds the overshoot."
 */

const SECONDS_PER_MINUTE = 60;

/** The five fields a preset fills (Appendix A). */
export interface BudgetSettings {
  readonly perTurnStepCap: number;
  readonly perTurnWallClockSeconds: number;
  readonly perTurnTokenCap: number;
  readonly perStudentDailyTokens: number;
  readonly perClassroomDailyTokens: number;
}

export const BUDGET_PRESET_NAMES = ["cautious", "standard", "generous"] as const;
export type BudgetPresetName = (typeof BUDGET_PRESET_NAMES)[number];

/**
 * Appendix A verbatim.
 *
 * "Selecting a preset fills all five fields; fields remain individually editable
 * afterwards" — so a preset is a starting point the panel writes into the
 * classroom, never a mode the classroom is left in.
 */
export const BUDGET_PRESETS: Readonly<Record<BudgetPresetName, BudgetSettings>> = {
  cautious: {
    perTurnStepCap: 10,
    perTurnWallClockSeconds: 3 * SECONDS_PER_MINUTE,
    perTurnTokenCap: 50_000,
    perStudentDailyTokens: 100_000,
    perClassroomDailyTokens: 1_000_000,
  },
  standard: {
    perTurnStepCap: 20,
    perTurnWallClockSeconds: 5 * SECONDS_PER_MINUTE,
    perTurnTokenCap: 100_000,
    perStudentDailyTokens: 250_000,
    perClassroomDailyTokens: 2_500_000,
  },
  generous: {
    perTurnStepCap: 30,
    perTurnWallClockSeconds: 10 * SECONDS_PER_MINUTE,
    perTurnTokenCap: 200_000,
    perStudentDailyTokens: 500_000,
    perClassroomDailyTokens: 5_000_000,
  },
};

/** The classroom's budget settings, as the loop and the start-of-turn check read them. */
export function budgetsOf(classroom: Pick<Classroom, keyof BudgetSettings>): BudgetSettings {
  return {
    perTurnStepCap: classroom.perTurnStepCap,
    perTurnWallClockSeconds: classroom.perTurnWallClockSeconds,
    perTurnTokenCap: classroom.perTurnTokenCap,
    perStudentDailyTokens: classroom.perStudentDailyTokens,
    perClassroomDailyTokens: classroom.perClassroomDailyTokens,
  };
}

/**
 * The half-open instant range of the budget day containing `at` (§10).
 *
 * "A day, for budget purposes, is the calendar day in the classroom's timezone —
 * allowances and caps reset at local midnight."
 *
 * Local midnight is converted through `date-fns-tz`, so a day is 23 or 25 hours
 * on the two transition days without this function knowing that (§5).
 */
const pad = (value: number) => String(value).padStart(2, "0");

export function budgetDayRange(
  timezone: string,
  at: Date = new Date(),
): { readonly start: Date; readonly end: Date } {
  const today = formatInTimeZone(at, timezone, "yyyy-MM-dd");
  const start = fromZonedTime(`${today}T00:00:00`, timezone);

  // The next local midnight, found from the calendar date rather than by adding
  // 24 hours — which would land an hour out on a transition day.
  const [year, month, day] = today.split("-").map(Number);
  const nextUtc = new Date(Date.UTC(year, month - 1, day) + 24 * 60 * 60 * 1000);
  const tomorrow = `${nextUtc.getUTCFullYear()}-${pad(nextUtc.getUTCMonth() + 1)}-${pad(nextUtc.getUTCDate())}`;

  return { start, end: fromZonedTime(`${tomorrow}T00:00:00`, timezone) };
}

/** Why a turn may not start. Each maps to a friendly, non-technical message (§10). */
export type BudgetRefusal = "student-allowance-exhausted" | "classroom-cap-exhausted";

/**
 * A discriminated union rather than an optional field: the refusal is present
 * exactly when the turn is refused, and the caller reads it without asserting.
 */
export type BudgetDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly refusal: BudgetRefusal };

export interface DailyConsumption {
  readonly studentTokens: number;
  readonly classroomTokens: number;
}

/**
 * Decide whether a turn may start (§10).
 *
 * The classroom cap is checked first: when the class ceiling is reached, an
 * individual pupil's remaining allowance is irrelevant, and the message they
 * see should say so.
 */
export function checkTurnBudget(
  budgets: BudgetSettings,
  consumed: DailyConsumption,
): BudgetDecision {
  if (consumed.classroomTokens >= budgets.perClassroomDailyTokens) {
    return { allowed: false, refusal: "classroom-cap-exhausted" };
  }
  if (consumed.studentTokens >= budgets.perStudentDailyTokens) {
    return { allowed: false, refusal: "student-allowance-exhausted" };
  }
  return { allowed: true };
}

/**
 * Whether internal utility work may run (§10).
 *
 * "Internal utility-alias calls count toward the per-classroom daily cap but
 * never toward a student's personal allowance; when the classroom cap is
 * exhausted, utility work is skipped and its fallback used."
 */
export function mayRunUtilityWork(
  budgets: BudgetSettings,
  consumed: Pick<DailyConsumption, "classroomTokens">,
): boolean {
  return consumed.classroomTokens < budgets.perClassroomDailyTokens;
}

/**
 * The per-turn ceiling, tracked while a turn streams.
 *
 * Hitting a cap "ends the turn gracefully: the loop stops at the next clean
 * boundary, partial content is preserved, and the student sees a friendly
 * notice — never an error" (§10). So this reports, and the loop decides where
 * the clean boundary is; nothing here throws.
 */
export class TurnBudget {
  readonly #budgets: BudgetSettings;
  readonly #startedAt: number;
  #steps = 0;
  #tokens = 0;
  /**
   * The running estimate for the step in flight.
   *
   * A gateway reports usage only once the response completes, so without a
   * provisional figure the token cap could not bind until after the tokens it
   * was meant to prevent had already been generated (§10).
   */
  #provisional = 0;

  constructor(budgets: BudgetSettings, startedAt: number = Date.now()) {
    this.#budgets = budgets;
    this.#startedAt = startedAt;
  }

  /** Count a completed model round trip. A tool call and its follow-up is one step (§10, §11). */
  recordStep(): void {
    this.#steps++;
  }

  /** Count usage as the gateway reports it, or as Setun estimated it (§10). */
  recordTokens(tokens: number): void {
    this.#tokens += tokens;
  }

  /** Add to the estimate for the step in flight. Superseded by `settleStepTokens`. */
  recordProvisionalTokens(tokens: number): void {
    this.#provisional += tokens;
  }

  /** Replace the in-flight estimate with the figure the gateway reported (§10). */
  settleStepTokens(reportedTokens: number): void {
    this.#provisional = 0;
    this.#tokens += reportedTokens;
  }

  get steps(): number {
    return this.#steps;
  }

  /** Settled tokens plus whatever the step in flight is estimated to have cost. */
  get tokens(): number {
    return this.#tokens + this.#provisional;
  }

  /**
   * Whether a cap has been reached, at `now`.
   *
   * Returns the cap that stopped it so the notice can say which, or null while
   * the turn may continue.
   */
  exceeded(now: number = Date.now()): "steps" | "wall-clock" | "tokens" | null {
    if (this.#steps >= this.#budgets.perTurnStepCap) return "steps";
    if (this.tokens >= this.#budgets.perTurnTokenCap) return "tokens";
    if (now - this.#startedAt >= this.#budgets.perTurnWallClockSeconds * 1000) {
      return "wall-clock";
    }
    return null;
  }
}
