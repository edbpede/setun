import { describe, expect, it } from "bun:test";
import {
  BUDGET_PRESETS,
  type BudgetSettings,
  budgetDayRange,
  checkTurnBudget,
  mayRunUtilityWork,
  TurnBudget,
} from "./budgets";

/**
 * Budget and allowance resolution, day-boundary reset in classroom timezone,
 * preset values (plan 2.7, PRD §10, §22).
 */

const STANDARD = BUDGET_PRESETS.standard;

describe("budget presets (Appendix A)", () => {
  it("Standard preset matches Appendix A verbatim", () => {
    expect(STANDARD.perTurnStepCap).toBe(20);
    expect(STANDARD.perTurnWallClockSeconds).toBe(5 * 60);
    expect(STANDARD.perTurnTokenCap).toBe(100_000);
    expect(STANDARD.perStudentDailyTokens).toBe(250_000);
    expect(STANDARD.perClassroomDailyTokens).toBe(2_500_000);
  });

  it("Cautious preset matches Appendix A", () => {
    expect(BUDGET_PRESETS.cautious.perTurnStepCap).toBe(10);
    expect(BUDGET_PRESETS.cautious.perTurnWallClockSeconds).toBe(3 * 60);
    expect(BUDGET_PRESETS.cautious.perTurnTokenCap).toBe(50_000);
    expect(BUDGET_PRESETS.cautious.perStudentDailyTokens).toBe(100_000);
    expect(BUDGET_PRESETS.cautious.perClassroomDailyTokens).toBe(1_000_000);
  });

  it("Generous preset matches Appendix A", () => {
    expect(BUDGET_PRESETS.generous.perTurnStepCap).toBe(30);
    expect(BUDGET_PRESETS.generous.perTurnWallClockSeconds).toBe(10 * 60);
    expect(BUDGET_PRESETS.generous.perTurnTokenCap).toBe(200_000);
    expect(BUDGET_PRESETS.generous.perStudentDailyTokens).toBe(500_000);
    expect(BUDGET_PRESETS.generous.perClassroomDailyTokens).toBe(5_000_000);
  });
});

describe("checkTurnBudget", () => {
  it("allows a turn when both budgets have headroom", () => {
    const result = checkTurnBudget(STANDARD, { studentTokens: 0, classroomTokens: 0 });

    expect(result.allowed).toBe(true);
  });

  it("refuses when the student allowance is exhausted", () => {
    const result = checkTurnBudget(STANDARD, {
      studentTokens: 250_000,
      classroomTokens: 100_000,
    });

    expect(result).toEqual({ allowed: false, refusal: "student-allowance-exhausted" });
  });

  it("refuses when the classroom cap is exhausted — even if the student has allowance left", () => {
    const result = checkTurnBudget(STANDARD, {
      studentTokens: 0,
      classroomTokens: 2_500_000,
    });

    expect(result).toEqual({ allowed: false, refusal: "classroom-cap-exhausted" });
  });

  it("names the classroom cap when both are exhausted at once", () => {
    const result = checkTurnBudget(STANDARD, {
      studentTokens: 500_000,
      classroomTokens: 3_000_000,
    });

    expect(result).toEqual({ allowed: false, refusal: "classroom-cap-exhausted" });
  });
});

describe("mayRunUtilityWork", () => {
  it("allows utility work when the classroom cap has headroom", () => {
    expect(mayRunUtilityWork(STANDARD, { classroomTokens: 0 })).toBe(true);
  });

  it("denies utility work when the classroom cap is exhausted", () => {
    expect(mayRunUtilityWork(STANDARD, { classroomTokens: 2_500_000 })).toBe(false);
  });
});

describe("TurnBudget — per-turn caps are checkpoints", () => {
  const budgets: BudgetSettings = {
    perTurnStepCap: 3,
    perTurnWallClockSeconds: 1,
    perTurnTokenCap: 500,
    perStudentDailyTokens: 10_000,
    perClassroomDailyTokens: 50_000,
  };

  it("reports no checkpoint on a fresh turn", () => {
    expect(new TurnBudget(budgets).reachedCaps()).toEqual([]);
  });

  it("reports the step checkpoint", () => {
    const tracker = new TurnBudget(budgets);
    for (let i = 0; i < 3; i++) tracker.recordStep();

    expect(tracker.reachedCaps()).toEqual(["steps"]);
  });

  it("reports the token checkpoint", () => {
    const tracker = new TurnBudget(budgets);
    tracker.recordTokens(500);

    expect(tracker.reachedCaps()).toEqual(["tokens"]);
  });

  it("reports wall-clock expiry", () => {
    const tracker = new TurnBudget(budgets, 1_000);

    expect(tracker.reachedCaps(1_000 + 2_000)).toEqual(["wall-clock"]);
  });

  /**
   * Every reached cap, not the first: continuing past a step checkpoint that
   * also blew the token allotment would otherwise stop again immediately.
   */
  it("reports every cap that was reached, steps first", () => {
    const tracker = new TurnBudget(budgets, 1_000);
    for (let i = 0; i < 3; i++) tracker.recordStep();
    tracker.recordTokens(1_000);

    expect(tracker.reachedCaps(1_000 + 2_000)).toEqual(["steps", "tokens", "wall-clock"]);
  });

  it("grants one more allotment of every reached cap when the pupil continues", () => {
    const tracker = new TurnBudget(budgets, 1_000);
    for (let i = 0; i < 3; i++) tracker.recordStep();
    tracker.recordTokens(500);

    tracker.extend(1_000);

    expect(tracker.reachedCaps(1_000)).toEqual([]);
    for (let i = 0; i < 3; i++) tracker.recordStep();
    expect(tracker.reachedCaps(1_000)).toEqual(["steps"]);
  });

  it("restarts the clock from the moment the pupil said to continue", () => {
    const tracker = new TurnBudget(budgets, 1_000);

    expect(tracker.reachedCaps(1_000 + 2_000)).toEqual(["wall-clock"]);
    tracker.extend(1_000 + 2_000);

    // One more second of wall clock, counted from the answer rather than from
    // the start of the turn.
    expect(tracker.reachedCaps(1_000 + 2_500)).toEqual([]);
    expect(tracker.reachedCaps(1_000 + 3_000)).toEqual(["wall-clock"]);
  });

  /**
   * The pupil's reading time is not the model's working time. Counting it would
   * make the very act of asking bring the next checkpoint forward.
   */
  it("excludes time spent waiting on the pupil from the clock", () => {
    const tracker = new TurnBudget(budgets, 1_000);
    tracker.recordWait(5_000);

    expect(tracker.elapsedMs(1_000 + 5_500)).toBe(500);
    expect(tracker.reachedCaps(1_000 + 5_500)).toEqual([]);
    expect(tracker.reachedCaps(1_000 + 6_000)).toEqual(["wall-clock"]);
  });

  it("offers one full allotment to every question the turn asks", () => {
    expect(new TurnBudget(BUDGET_PRESETS.standard).allotmentMs).toBe(300_000);
  });
});

/**
 * The hard ceilings, binding *during* a turn (§10).
 *
 * A turn that starts with the day 99 % spent used to run to its own per-turn cap
 * regardless; now the day's figures travel with it and stop it where they run out.
 */
describe("TurnBudget — the daily ceilings", () => {
  const budgets: BudgetSettings = {
    perTurnStepCap: 100,
    perTurnWallClockSeconds: 600,
    perTurnTokenCap: 100_000,
    perStudentDailyTokens: 10_000,
    perClassroomDailyTokens: 50_000,
  };

  it("counts the turn's own tokens against what the day had already spent", () => {
    const tracker = new TurnBudget(budgets, 1_000, {
      studentTokens: 9_000,
      classroomTokens: 20_000,
    });
    tracker.recordTokens(500);

    expect(tracker.dailyUsed()).toEqual({ studentTokens: 9_500, classroomTokens: 20_500 });
    expect(tracker.dailyExhausted()).toBeNull();

    tracker.recordTokens(500);
    expect(tracker.dailyExhausted()).toBe("student-allowance-exhausted");
  });

  it("names the classroom cap first, exactly as checkTurnBudget does", () => {
    const tracker = new TurnBudget(budgets, 1_000, {
      studentTokens: 10_000,
      classroomTokens: 50_000,
    });

    expect(tracker.dailyExhausted()).toBe("classroom-cap-exhausted");
  });

  it("reports the fuller of the two layers, and the figures that go with it", () => {
    const tracker = new TurnBudget(budgets, 1_000, {
      studentTokens: 1_000,
      classroomTokens: 40_000,
    });

    expect(tracker.dailyFraction()).toBeCloseTo(0.8);
    expect(tracker.dailyBinding()).toEqual({ usedTokens: 40_000, limitTokens: 50_000 });
  });

  it("warns exactly once, and only past 70 %", () => {
    const tracker = new TurnBudget(budgets, 1_000, { studentTokens: 6_000, classroomTokens: 0 });

    expect(tracker.takeWarning()).toBe(false);
    expect(tracker.warningPending).toBe(false);

    tracker.recordTokens(1_000);
    expect(tracker.takeWarning()).toBe(true);
    expect(tracker.takeWarning()).toBe(false);
    expect(tracker.warningPending).toBe(true);

    tracker.acknowledgeWarning();
    expect(tracker.warningPending).toBe(false);
  });
});

describe("budgetDayRange — day boundary in the classroom timezone (§10)", () => {
  it("runs from local midnight to local midnight", () => {
    // 2026-01-05 09:00 Copenhagen (CET, UTC+1) is 08:00 UTC.
    const at = new Date("2026-01-05T08:00:00Z");
    const range = budgetDayRange("Europe/Copenhagen", at);

    // Local midnight is 23:00 UTC on the 4th.
    expect(range.start.toISOString()).toBe("2026-01-04T23:00:00.000Z");
    // Next local midnight is 23:00 UTC on the 5th.
    expect(range.end.toISOString()).toBe("2026-01-05T23:00:00.000Z");
  });

  it("handles the spring-forward day — the budget day is 23 hours", () => {
    // 2026-03-29 is the Copenhagen spring-forward. Local midnight 29th = 28th 23:00 UTC (CET).
    // Local midnight 30th = 29th 22:00 UTC (CEST). That is 23 real hours, and it had better be
    // that rather than 24.
    const at = new Date("2026-03-29T10:00:00Z");
    const range = budgetDayRange("Europe/Copenhagen", at);

    expect(range.start.toISOString()).toBe("2026-03-28T23:00:00.000Z");
    expect(range.end.toISOString()).toBe("2026-03-29T22:00:00.000Z");

    const dayMs = range.end.getTime() - range.start.getTime();
    expect(dayMs).toBe(23 * 60 * 60 * 1000);
  });

  it("handles the fall-back day — the budget day is 25 hours", () => {
    // 2026-10-25 is the Copenhagen fall-back.
    const at = new Date("2026-10-25T10:00:00Z");
    const range = budgetDayRange("Europe/Copenhagen", at);

    expect(range.start.toISOString()).toBe("2026-10-24T22:00:00.000Z");
    expect(range.end.toISOString()).toBe("2026-10-25T23:00:00.000Z");

    const dayMs = range.end.getTime() - range.start.getTime();
    expect(dayMs).toBe(25 * 60 * 60 * 1000);
  });

  it("gives a different range for a different timezone at the same instant", () => {
    const at = new Date("2026-01-05T08:00:00Z");
    const copenhagen = budgetDayRange("Europe/Copenhagen", at);
    const tokyo = budgetDayRange("Asia/Tokyo", at);

    expect(copenhagen.start.toISOString()).not.toBe(tokyo.start.toISOString());
  });
});
