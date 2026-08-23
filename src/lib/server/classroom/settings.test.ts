import { beforeEach, describe, expect, it } from "bun:test";
import { buildSystemPrompt } from "../agent/system-prompt";
import type { AppDatabase } from "../db/client";
import { updateClassroomSettings } from "../db/queries/classrooms";
import { setStudentInstructions, setStudentInterfaceLanguage } from "../db/queries/students";
import type { Classroom, Student } from "../db/schema";
import { createTestDatabase, seedTestFixtures } from "../db/testing";
import { resolveStudentSettings, studentInterfaceLanguage } from "./settings";

/**
 * Settings resolution and prompt layering (plan 2.2, 2.9, PRD §2, §8, §10, §22).
 *
 * "`bun test` layering with all layers populated" (plan 2.9), and the
 * granularity principle: a classroom sets the policy, a pupil may override the
 * dimensions §8 names (§2).
 */

let db: AppDatabase;
let classroom: Classroom;
let student: Student;

beforeEach(() => {
  db = createTestDatabase();
  const fixtures = seedTestFixtures(db);
  classroom = fixtures.classroom;
  student = fixtures.student;
});

describe("resolveStudentSettings", () => {
  it("falls back to the classroom for every dimension a pupil has not overridden", () => {
    const resolved = resolveStudentSettings(classroom, student);

    expect(resolved.interfaceLanguage).toBe(classroom.interfaceLanguage);
    expect(resolved.attachmentsEnabled).toBe(classroom.attachmentsEnabled);
    expect(resolved.studentInstructions).toBeNull();
  });

  it("prefers a pupil's own interface language over the classroom's (§8, §18)", () => {
    const resolved = resolveStudentSettings(classroom, { ...student, interfaceLanguage: "en" });

    expect(classroom.interfaceLanguage).toBe("da");
    expect(resolved.interfaceLanguage).toBe("en");
  });

  it("prefers a per-student attachment override over the classroom toggle (§10)", () => {
    const resolved = resolveStudentSettings(classroom, { ...student, attachmentsEnabled: false });

    expect(classroom.attachmentsEnabled).toBe(true);
    expect(resolved.attachmentsEnabled).toBe(false);
  });

  it("returns both instruction layers rather than letting one replace the other (§10)", () => {
    const withInstructions = { ...classroom, classroomInstructions: "Svar altid på dansk." };
    const resolved = resolveStudentSettings(withInstructions, {
      ...student,
      instructions: "Forklar ekstra grundigt.",
    });

    expect(resolved.classroomInstructions).toBe("Svar altid på dansk.");
    expect(resolved.studentInstructions).toBe("Forklar ekstra grundigt.");
  });

  it("treats a cleared instructions field as absent, not as an empty instruction", () => {
    const resolved = resolveStudentSettings(
      { ...classroom, classroomInstructions: "   " },
      { ...student, instructions: "" },
    );

    expect(resolved.classroomInstructions).toBeNull();
    expect(resolved.studentInstructions).toBeNull();
  });
});

describe("system-prompt layering, end to end (plan 2.9, §10, §22)", () => {
  it("carries both educator layers into the prompt, in order", () => {
    updateClassroomSettings(db, {
      classroomId: classroom.id,
      settings: { classroomInstructions: "Svar altid på dansk." },
    });
    setStudentInstructions(db, {
      studentId: student.id,
      classroomId: classroom.id,
      instructions: "Forklar ekstra grundigt.",
    });

    const stored = { ...classroom, classroomInstructions: "Svar altid på dansk." };
    const settings = resolveStudentSettings(stored, {
      ...student,
      instructions: "Forklar ekstra grundigt.",
    });

    const prompt = buildSystemPrompt({
      classroomInstructions: settings.classroomInstructions,
      studentInstructions: settings.studentInstructions,
      skillIndex: [{ name: "citation", description: "Cite sources" }],
    });

    const classroomAt = prompt.indexOf("Svar altid på dansk.");
    const studentAt = prompt.indexOf("Forklar ekstra grundigt.");
    const skillAt = prompt.indexOf("citation");

    expect(classroomAt).toBeGreaterThan(0);
    // Base, then classroom, then student, then the skill index (§10).
    expect(studentAt).toBeGreaterThan(classroomAt);
    expect(skillAt).toBeGreaterThan(studentAt);
  });
});

describe("studentInterfaceLanguage (§8, §18)", () => {
  it("uses the classroom setting when the pupil has not chosen", () => {
    expect(studentInterfaceLanguage(db, student)).toBe("da");
  });

  it("uses the pupil's own choice once they make one", () => {
    setStudentInterfaceLanguage(db, { studentId: student.id, interfaceLanguage: "en" });

    expect(studentInterfaceLanguage(db, { ...student, interfaceLanguage: "en" })).toBe("en");
  });

  it("follows the classroom again when the pupil clears their choice", () => {
    updateClassroomSettings(db, {
      classroomId: classroom.id,
      settings: { interfaceLanguage: "en" },
    });

    expect(studentInterfaceLanguage(db, { ...student, interfaceLanguage: null })).toBe("en");
  });
});
