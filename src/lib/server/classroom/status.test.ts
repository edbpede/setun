import { beforeEach, describe, expect, it } from "bun:test";
import type { AppDatabase } from "../db/client";
import { setClassroomState, updateClassroomSettings } from "../db/queries/classrooms";
import { createAlias, updateAlias } from "../db/queries/model-aliases";
import { recordUsageEvent } from "../db/queries/usage";
import type { Classroom, ModelAlias, Student } from "../db/schema";
import { createTestDatabase, seedTestFixtures } from "../db/testing";
import { resolveClassroomStatus, statusFingerprint } from "./status";

/**
 * The student-facing classroom status (plan 2.4, 2.5, 2.8, PRD §8, §10, §18).
 *
 * The allowance display and the closed screen both read this, so the day
 * boundary it uses is the classroom's local midnight, and the cost estimate it
 * carries is display-only — present when prices are configured, absent when they
 * are not, never zero (§10).
 */

let db: AppDatabase;
let classroom: Classroom;
let student: Student;
let alias: ModelAlias;

beforeEach(() => {
  db = createTestDatabase();
  const fixtures = seedTestFixtures(db);
  classroom = fixtures.classroom;
  student = fixtures.student;
  alias = fixtures.alias;
});

const spend = (input: { inputTokens: number; outputTokens: number; studentId?: string | null }) =>
  recordUsageEvent(db, {
    classroomId: classroom.id,
    studentId: input.studentId === undefined ? student.id : input.studentId,
    modelAliasId: alias.id,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    estimated: false,
  });

describe("availability", () => {
  it("reports an open classroom with its timezone, so the screen can name a lesson", () => {
    setClassroomState(db, { classroomId: classroom.id, state: "open" });

    const status = resolveClassroomStatus(db, student);

    expect(status.open).toBe(true);
    expect(status.reason).toBe("explicit-open");
    expect(status.timezone).toBe("Europe/Copenhagen");
  });

  it("reports a lock, and promises no opening the educator has not agreed to", () => {
    setClassroomState(db, { classroomId: classroom.id, state: "locked" });

    const status = resolveClassroomStatus(db, student);

    expect(status.open).toBe(false);
    expect(status.reason).toBe("explicit-lock");
    expect(status.nextOpeningAt).toBeNull();
  });

  it("names the next scheduled opening for the closed screen (§8)", () => {
    updateClassroomSettings(db, {
      classroomId: classroom.id,
      settings: { weeklySchedule: [{ weekday: 1, startMinute: 9 * 60, endMinute: 10 * 60 }] },
    });

    // Sunday 4 January 2026, 12:00 UTC — the lesson is the next morning.
    const status = resolveClassroomStatus(db, student, new Date("2026-01-04T12:00:00Z"));

    expect(status.open).toBe(false);
    // Monday 09:00 Copenhagen (CET) is 08:00 UTC.
    expect(status.nextOpeningAt).toBe("2026-01-05T08:00:00.000Z");
  });
});

describe("allowance (§10, §18)", () => {
  it("counts only this student's own consumption against their allowance", () => {
    const other = seedTestFixtures(db, { label: "quiet-heron", digest: "digest-2" });

    spend({ inputTokens: 1_000, outputTokens: 500 });
    recordUsageEvent(db, {
      classroomId: classroom.id,
      studentId: other.student.id,
      modelAliasId: alias.id,
      inputTokens: 9_000,
      outputTokens: 0,
      estimated: false,
    });

    const status = resolveClassroomStatus(db, student);

    expect(status.allowance.usedTokens).toBe(1_500);
    expect(status.allowance.remainingTokens).toBe(classroom.perStudentDailyTokens - 1_500);
    expect(status.allowance.exhausted).toBe(false);
  });

  it("reports an exhausted allowance without going negative", () => {
    spend({ inputTokens: classroom.perStudentDailyTokens + 5_000, outputTokens: 0 });

    const status = resolveClassroomStatus(db, student);

    expect(status.allowance.exhausted).toBe(true);
    expect(status.allowance.remainingTokens).toBe(0);
  });

  it("flags an exhausted classroom cap separately — a different message (§10)", () => {
    // Utility work: a null student, so it counts to the class and to no pupil.
    spend({ inputTokens: classroom.perClassroomDailyTokens, outputTokens: 0, studentId: null });

    const status = resolveClassroomStatus(db, student);

    expect(status.allowance.classroomExhausted).toBe(true);
    // The pupil's own allowance is untouched by utility work (§10).
    expect(status.allowance.usedTokens).toBe(0);
    expect(status.allowance.exhausted).toBe(false);
  });

  it("resets on the next budget day in the classroom's timezone (§10)", () => {
    // Usage rows are stamped as they are written, so the two instants below are
    // relative to that. Which instant local midnight falls on — and that a
    // transition day is 23 or 25 hours long — is `budgetDayRange`'s own suite.
    spend({ inputTokens: 4_000, outputTokens: 0 });

    const today = resolveClassroomStatus(db, student);
    const tomorrow = resolveClassroomStatus(
      db,
      student,
      new Date(Date.now() + 25 * 60 * 60 * 1000),
    );

    expect(today.allowance.usedTokens).toBe(4_000);
    expect(tomorrow.allowance.usedTokens).toBe(0);
    expect(tomorrow.allowance.remainingTokens).toBe(classroom.perStudentDailyTokens);
  });
});

describe("cost estimate (§10, Appendix A)", () => {
  it("prices the day at the alias's rates and the classroom's exchange rate", () => {
    updateAlias(db, {
      aliasId: alias.id,
      values: { inputPricePerMillion: 3, outputPricePerMillion: 15 },
    });

    spend({ inputTokens: 1_000_000, outputTokens: 1_000_000 });

    const status = resolveClassroomStatus(db, student);

    expect(status.allowance.costUsd).toBe(18);
    // Appendix A default: 7.00 DKK/USD.
    expect(status.allowance.costDkk).toBe(126);
  });

  it("gives no estimate when the alias carries no price — never a zero (§10)", () => {
    spend({ inputTokens: 100_000, outputTokens: 100_000 });

    const status = resolveClassroomStatus(db, student);

    expect(status.allowance.costUsd).toBeNull();
    expect(status.allowance.costDkk).toBeNull();
  });

  it("sums across the aliases a pupil used in one day", () => {
    const second = createAlias(db, {
      name: "Powerful",
      gatewayModelId: "big-model",
      dialect: "openai",
      inputPricePerMillion: 10,
      outputPricePerMillion: 10,
    });
    updateAlias(db, {
      aliasId: alias.id,
      values: { inputPricePerMillion: 1, outputPricePerMillion: 1 },
    });

    spend({ inputTokens: 1_000_000, outputTokens: 0 });
    recordUsageEvent(db, {
      classroomId: classroom.id,
      studentId: student.id,
      modelAliasId: second.id,
      inputTokens: 1_000_000,
      outputTokens: 0,
      estimated: false,
    });

    expect(resolveClassroomStatus(db, student).allowance.costUsd).toBe(11);
  });
});

describe("statusFingerprint — what the push channel considers a change", () => {
  it("changes when the classroom locks", () => {
    const before = statusFingerprint(resolveClassroomStatus(db, student));
    setClassroomState(db, { classroomId: classroom.id, state: "locked" });

    expect(statusFingerprint(resolveClassroomStatus(db, student))).not.toBe(before);
  });

  it("changes when a turn spends allowance, so a pupil's meter moves", () => {
    const before = statusFingerprint(resolveClassroomStatus(db, student));
    spend({ inputTokens: 100, outputTokens: 100 });

    expect(statusFingerprint(resolveClassroomStatus(db, student))).not.toBe(before);
  });

  it("is unchanged when nothing happened", () => {
    const first = statusFingerprint(resolveClassroomStatus(db, student));

    expect(statusFingerprint(resolveClassroomStatus(db, student))).toBe(first);
  });
});
