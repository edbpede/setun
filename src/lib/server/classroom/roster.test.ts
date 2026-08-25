import { beforeEach, describe, expect, it } from "bun:test";
import type { AppDatabase } from "../db/client";
import { updateAlias } from "../db/queries/model-aliases";
import { setStudentInstructions } from "../db/queries/students";
import { recordUsageEvent } from "../db/queries/usage";
import type { Classroom, ModelAlias, Student } from "../db/schema";
import { createTestDatabase, seedTestFixtures } from "../db/testing";
import { resolveRoster } from "./roster";

/**
 * The educator's roster view (plan 2.8, PRD §10, §16, §17).
 *
 * "Roster: per-student status, usage and allowance (with cost estimate)" (§17)
 * — and nothing a pupil wrote, because "educators have no interface for reading
 * student conversations" (§16). The last test asserts that absence, which is the
 * one property here that is a privacy requirement rather than a feature.
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

const spend = (input: { studentId: string | null; inputTokens: number; outputTokens: number }) =>
  recordUsageEvent(db, {
    classroomId: classroom.id,
    studentId: input.studentId,
    modelAliasId: alias.id,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    estimated: false,
  });

describe("resolveRoster", () => {
  it("lists every pupil in the classroom, including those with no usage", () => {
    const roster = resolveRoster(db, classroom);

    expect(roster).toHaveLength(1);
    expect(roster[0].label).toBe(student.label);
    expect(roster[0].usedTokens).toBe(0);
    expect(roster[0].limitTokens).toBe(classroom.perStudentDailyTokens);
  });

  it("counts each pupil's own usage against their own allowance", () => {
    const other = seedTestFixtures(db, { label: "quiet-heron", digest: "digest-2" });

    spend({ studentId: student.id, inputTokens: 3_000, outputTokens: 1_000 });
    recordUsageEvent(db, {
      classroomId: classroom.id,
      studentId: other.student.id,
      modelAliasId: alias.id,
      inputTokens: 50_000,
      outputTokens: 0,
      estimated: false,
    });

    const roster = resolveRoster(db, classroom);
    const entry = roster.find((row) => row.id === student.id);

    // The other pupil is in another classroom entirely, so their spend is not here.
    expect(roster).toHaveLength(1);
    expect(entry?.usedTokens).toBe(4_000);
  });

  it("never charges utility work to a pupil (§10)", () => {
    spend({ studentId: null, inputTokens: 9_000, outputTokens: 1_000 });

    expect(resolveRoster(db, classroom)[0].usedTokens).toBe(0);
  });

  it("flags a pupil who has used their day up", () => {
    spend({
      studentId: student.id,
      inputTokens: classroom.perStudentDailyTokens,
      outputTokens: 0,
    });

    expect(resolveRoster(db, classroom)[0].exhausted).toBe(true);
  });

  it("prices the day where the alias carries prices (§10, Appendix A)", () => {
    updateAlias(db, {
      aliasId: alias.id,
      values: { inputPricePerMillion: 3, outputPricePerMillion: 15 },
    });
    spend({ studentId: student.id, inputTokens: 1_000_000, outputTokens: 1_000_000 });

    const entry = resolveRoster(db, classroom)[0];

    expect(entry.costUsd).toBe(18);
    expect(entry.costDkk).toBe(126);
  });

  it("gives no estimate where no price is configured — never a zero (§10)", () => {
    spend({ studentId: student.id, inputTokens: 100_000, outputTokens: 100_000 });

    const entry = resolveRoster(db, classroom)[0];

    expect(entry.costUsd).toBeNull();
    expect(entry.costDkk).toBeNull();
  });

  it("carries the educator's own instructions and nothing the pupil wrote (§16)", () => {
    setStudentInstructions(db, {
      studentId: student.id,
      classroomId: classroom.id,
      instructions: "Forklar ekstra grundigt.",
    });

    const entry = resolveRoster(db, classroom)[0];

    expect(entry.instructions).toBe("Forklar ekstra grundigt.");
    // The shape is closed: no conversation, message or prompt field exists to
    // read, which is the point (§16).
    expect(Object.keys(entry).sort()).toEqual([
      "attachmentsEffective",
      "attachmentsOverride",
      "costDkk",
      "costUsd",
      "credentialHint",
      "displayName",
      "exhausted",
      "id",
      "instructions",
      "label",
      "lastActivityAt",
      "limitTokens",
      "status",
      "usedTokens",
    ]);
  });
});
