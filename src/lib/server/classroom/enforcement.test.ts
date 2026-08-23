import { beforeEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { BUDGET_PRESETS } from "../agent/budgets";
import type { AppDatabase } from "../db/client";
import { allowAlias } from "../db/queries/classroom-aliases";
import { setClassroomState } from "../db/queries/classrooms";
import { createAlias } from "../db/queries/model-aliases";
import { createStudent } from "../db/queries/students";
import { recordUsageEvent } from "../db/queries/usage";
import {
  type Classroom,
  type ModelAlias,
  modelAlias,
  type Student,
  usageEvent,
} from "../db/schema";
import { createTestDatabase, seedTestFixtures } from "../db/testing";
import { checkModelAccess } from "./enforcement";

/**
 * Server-side enforcement (plan 2.4, PRD §8, §10, §21, §22).
 *
 * "Security tests via direct API access: out-of-hours refusal, disabled model
 * refusal, refusal after lock mid-session" (§22).
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

  // Allowlist the alias so the baseline state passes.
  allowAlias(db, { classroomId: classroom.id, modelAliasId: alias.id });
  // Open the classroom.
  setClassroomState(db, { classroomId: classroom.id, state: "open" });
});

const check = (now?: Date) => checkModelAccess({ db, student, modelAliasId: alias.id, now });

describe("availability enforcement (§8, §22)", () => {
  it("allows a request when the classroom is open and the alias is allowlisted", () => {
    expect(check().allowed).toBe(true);
  });

  it("refuses when the classroom is locked — even if a schedule would otherwise open it", () => {
    // Lock explicitly — the educator's Lock button (§8).
    setClassroomState(db, { classroomId: classroom.id, state: "locked" });

    const result = check();

    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toBe("classroom-locked");
  });

  it("refuses outside a scheduled window", () => {
    // Return to schedule following with no windows — always closed.
    setClassroomState(db, { classroomId: classroom.id, state: "scheduled" });

    const result = check();

    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toBe("outside-schedule");
  });
});

describe("model allowlist enforcement (§9, §22)", () => {
  it("refuses a model not on the classroom's allowlist", () => {
    const otherAlias = createAlias(db, {
      name: "Unlisted",
      gatewayModelId: "other-model",
      dialect: "openai",
    });

    const result = checkModelAccess({
      db,
      student,
      modelAliasId: otherAlias.id,
    });

    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toBe("model-not-allowed");
  });

  it("refuses an alias the educator has taken out of service", () => {
    db.update(modelAlias).set({ available: false }).where(eq(modelAlias.id, alias.id)).run();

    const result = check();

    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toBe("model-not-allowed");
  });
});

describe("budget enforcement (§10, §22)", () => {
  it("refuses when the student's daily allowance is exhausted", () => {
    const { perStudentDailyTokens } = BUDGET_PRESETS.standard;

    recordUsageEvent(db, {
      classroomId: classroom.id,
      studentId: student.id,
      modelAliasId: alias.id,
      inputTokens: perStudentDailyTokens,
      outputTokens: 0,
      estimated: false,
    });

    const result = check();

    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toBe("student-allowance-exhausted");
  });

  it("refuses when the classroom cap is exhausted, even if the student has allowance left", () => {
    const { perClassroomDailyTokens } = BUDGET_PRESETS.standard;

    // Consume the class cap through a different student.
    const other = createStudent(db, {
      classroomId: classroom.id,
      label: "quiet-heron",
      credentialDigest: crypto.randomUUID(),
      credentialHint: "EFGH",
    });
    recordUsageEvent(db, {
      classroomId: classroom.id,
      studentId: other.id,
      modelAliasId: alias.id,
      inputTokens: perClassroomDailyTokens,
      outputTokens: 0,
      estimated: false,
    });

    const result = check();

    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toBe("classroom-cap-exhausted");
  });

  it("resets at local midnight — a new day grants a fresh allowance", () => {
    const budget = BUDGET_PRESETS.standard;

    // Insert the usage event with a timestamp within the budget day that
    // contains beforeMidnight. We override createdAt so the sum query picks it up.
    const beforeMidnight = new Date("2026-01-05T22:30:00Z"); // 23:30 CET

    db.insert(usageEvent)
      .values({
        classroomId: classroom.id,
        studentId: student.id,
        modelAliasId: alias.id,
        inputTokens: budget.perStudentDailyTokens,
        outputTokens: 0,
        estimated: false,
        createdAt: beforeMidnight,
      })
      .run();

    // Still refused before midnight.
    expect(check(beforeMidnight).allowed).toBe(false);

    // Just after local midnight — 23:01 UTC is 00:01 CET on the 6th. New day.
    const afterMidnight = new Date("2026-01-05T23:01:00Z");
    expect(check(afterMidnight).allowed).toBe(true);
  });
});
