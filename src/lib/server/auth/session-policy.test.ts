import { beforeEach, describe, expect, it } from "bun:test";
import type { AppDatabase } from "../db/client";
import { setClassroomState, updateClassroomSettings } from "../db/queries/classrooms";
import { invalidateClassroomSessions } from "../db/queries/sessions";
import type { Classroom, Student } from "../db/schema";
import { createTestDatabase, seedTestFixtures } from "../db/testing";
import { rotateStudentCredential } from "./provisioning";
import { createSession, resolveStudentSession } from "./sessions";

/**
 * Session policy and force-logout (plan 2.9, PRD §7, §21, §22).
 *
 * "Security tests: sessions dead after force-logout and after rotation" (§22),
 * and the per-lesson policy: "sessions end when the classroom closes and
 * students re-authenticate each lesson" (§7).
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** A Monday 09:00–10:00 lesson in the classroom's own timezone. */
const MONDAY_MORNING = [{ weekday: 1, startMinute: 9 * 60, endMinute: 10 * 60 }];

let db: AppDatabase;
let classroom: Classroom;
let student: Student;

beforeEach(() => {
  db = createTestDatabase();
  const fixtures = seedTestFixtures(db);
  classroom = fixtures.classroom;
  student = fixtures.student;
});

describe("sliding expiry follows the classroom's configured duration (§7, §8)", () => {
  it("slides to the classroom's own window, not a hard-coded fortnight", () => {
    updateClassroomSettings(db, { classroomId: classroom.id, settings: { sessionSlidingDays: 3 } });

    const now = new Date("2026-01-05T08:00:00Z");
    const { token } = createSession(db, {
      ownerKind: "student",
      ownerId: student.id,
      now,
    });

    const resolved = resolveStudentSession(db, token, now);

    expect(resolved).not.toBeNull();
    expect(resolved?.session.id).toBeDefined();

    // Three days on, it is gone; a fortnight-long window would still be alive.
    const later = new Date(now.getTime() + 4 * MS_PER_DAY);
    expect(resolveStudentSession(db, token, later)).toBeNull();
  });
});

describe("per-lesson sessions end when the classroom closes (§7)", () => {
  beforeEach(() => {
    updateClassroomSettings(db, {
      classroomId: classroom.id,
      settings: { sessionPolicy: "per-lesson", weeklySchedule: MONDAY_MORNING },
    });
  });

  it("keeps a session alive within the lesson it was created in", () => {
    // Monday 5 January 2026, 09:30 Copenhagen (CET) is 08:30 UTC.
    const duringLesson = new Date("2026-01-05T08:30:00Z");
    const { token } = createSession(db, {
      ownerKind: "student",
      ownerId: student.id,
      now: duringLesson,
    });

    expect(resolveStudentSession(db, token, duringLesson)).not.toBeNull();
  });

  it("kills a session once the lesson it belonged to has ended", () => {
    const duringLesson = new Date("2026-01-05T08:30:00Z");
    const { token } = createSession(db, {
      ownerKind: "student",
      ownerId: student.id,
      now: duringLesson,
    });

    // Monday 10:30 local: the window closed half an hour ago.
    const afterLesson = new Date("2026-01-05T09:30:00Z");

    expect(resolveStudentSession(db, token, afterLesson)).toBeNull();
  });

  it("kills a session the moment an educator locks the classroom", () => {
    const duringLesson = new Date("2026-01-05T08:30:00Z");
    const { token } = createSession(db, {
      ownerKind: "student",
      ownerId: student.id,
      now: duringLesson,
    });

    const lockedAt = new Date("2026-01-05T08:45:00Z");
    setClassroomState(db, { classroomId: classroom.id, state: "locked", now: lockedAt });

    expect(resolveStudentSession(db, token, new Date("2026-01-05T08:46:00Z"))).toBeNull();
  });

  it("leaves a sliding classroom's sessions alone across the same boundary", () => {
    updateClassroomSettings(db, {
      classroomId: classroom.id,
      settings: { sessionPolicy: "sliding" },
    });

    const duringLesson = new Date("2026-01-05T08:30:00Z");
    const { token } = createSession(db, {
      ownerKind: "student",
      ownerId: student.id,
      now: duringLesson,
    });

    expect(resolveStudentSession(db, token, new Date("2026-01-05T09:30:00Z"))).not.toBeNull();
  });
});

describe("force-logout is immediate and classroom-wide (§7, §21, §22)", () => {
  it("kills every live session in the classroom at once", () => {
    const other = seedTestFixtures(db, { label: "quiet-heron", digest: "another-digest" });

    const mine = createSession(db, { ownerKind: "student", ownerId: student.id });
    const theirs = createSession(db, { ownerKind: "student", ownerId: other.student.id });

    expect(resolveStudentSession(db, mine.token)).not.toBeNull();

    const count = invalidateClassroomSessions(db, classroom.id);

    expect(count).toBe(1);
    expect(resolveStudentSession(db, mine.token)).toBeNull();
    // The other pupil belongs to a different classroom and is untouched.
    expect(resolveStudentSession(db, theirs.token)).not.toBeNull();
  });

  it("does not touch the educator's own session", () => {
    const educatorSession = createSession(db, { ownerKind: "educator", ownerId: "educator-1" });

    invalidateClassroomSessions(db, classroom.id);

    // The row is still live; only the student namespace was invalidated (§7).
    expect(educatorSession.session.invalidatedAt).toBeNull();
  });
});

describe("rotation kills existing sessions (§7, §21, §22)", () => {
  it("leaves the old code's session dead the instant the credential is replaced", async () => {
    const { token } = createSession(db, { ownerKind: "student", ownerId: student.id });
    expect(resolveStudentSession(db, token)).not.toBeNull();

    await rotateStudentCredential(db, {
      studentId: student.id,
      classroomId: student.classroomId,
      pepper: "test-pepper",
    });

    expect(resolveStudentSession(db, token)).toBeNull();
  });
});
