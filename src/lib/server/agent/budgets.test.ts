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

describe("TurnBudget — per-turn caps", () => {
  const budgets: BudgetSettings = {
    perTurnStepCap: 3,
    perTurnWallClockSeconds: 1,
    perTurnTokenCap: 500,
    perStudentDailyTokens: 10_000,
    perClassroomDailyTokens: 50_000,
  };

  it("reports no cap exceeded on a fresh turn", () => {
    expect(new TurnBudget(budgets).exceeded()).toBeNull();
  });

  it("reports the step cap", () => {
    const tracker = new TurnBudget(budgets);
    for (let i = 0; i < 3; i++) tracker.recordStep();

    expect(tracker.exceeded()).toBe("steps");
  });

  it("reports the token cap", () => {
    const tracker = new TurnBudget(budgets);
    tracker.recordTokens(500);

    expect(tracker.exceeded()).toBe("tokens");
  });

  it("reports wall-clock expiry", () => {
    const startedAt = Date.now() - 2000;
    const tracker = new TurnBudget(budgets, startedAt);

    expect(tracker.exceeded()).toBe("wall-clock");
  });

  it("steps takes priority over tokens when both are reached", () => {
    const tracker = new TurnBudget(budgets);
    for (let i = 0; i < 3; i++) tracker.recordStep();
    tracker.recordTokens(1000);

    expect(tracker.exceeded()).toBe("steps");
  });
});

/**
 * What every wait inside a turn is bounded by (§10, §11).
 *
 * The figure has to be what is *left*, not the cap: a wait handed the whole cap
 * restarts it, and one permission question followed by three elicitation rounds
 * would keep a five-minute turn alive for twenty.
 */
describe("TurnBudget — the wall clock a wait may use", () => {
  const budgets: BudgetSettings = {
    perTurnStepCap: 20,
    perTurnWallClockSeconds: 300,
    perTurnTokenCap: 100_000,
    perStudentDailyTokens: 250_000,
    perClassroomDailyTokens: 2_500_000,
  };

  it("offers the whole cap to a turn that has just started", () => {
    expect(new TurnBudget(budgets, 1_000).remainingWallClockMs(1_000)).toBe(300_000);
  });

  it("draws successive waits down one cap rather than giving each the whole of it", () => {
    const tracker = new TurnBudget(budgets, 1_000);

    // Four waits, each taking a minute. The fourth is bounded by the minute the
    // turn has left, not by the five it started with.
    expect(tracker.remainingWallClockMs(1_000 + 60_000)).toBe(240_000);
    expect(tracker.remainingWallClockMs(1_000 + 120_000)).toBe(180_000);
    expect(tracker.remainingWallClockMs(1_000 + 180_000)).toBe(120_000);
    expect(tracker.remainingWallClockMs(1_000 + 240_000)).toBe(60_000);
  });

  it("offers nothing once the cap is spent, rather than a negative wait", () => {
    const tracker = new TurnBudget(budgets, 1_000);

    expect(tracker.remainingWallClockMs(1_000 + 300_000)).toBe(0);
    expect(tracker.remainingWallClockMs(1_000 + 900_000)).toBe(0);
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
