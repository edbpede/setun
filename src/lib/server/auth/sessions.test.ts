import { beforeEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import type { AppDatabase } from "../db/client";
import { createClassroom } from "../db/queries/classrooms";
import { createStudent } from "../db/queries/students";
import { type Student, student as studentTable } from "../db/schema";
import { createTestDatabase } from "../db/testing";
import {
  createSession,
  destroySession,
  EDUCATOR_SESSION_TTL_DAYS,
  invalidateAllSessionsFor,
  resolveStudentSession,
  STUDENT_SESSION_TTL_DAYS,
  ttlDaysFor,
} from "./sessions";

/**
 * Session lifetime, sliding expiry and invalidation (plan 1.3, PRD §7, §21, §22).
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

let db: AppDatabase;
let student: Student;

beforeEach(() => {
  db = createTestDatabase();
  const classroom = createClassroom(db, { name: "7.B" });
  student = createStudent(db, {
    classroomId: classroom.id,
    label: "brave-otter",
    credentialDigest: "digest-one",
    credentialHint: "ABCD",
  });
});

const issue = () => createSession(db, { ownerKind: "student", ownerId: student.id });

describe("createSession", () => {
  it("stores only a digest — the token itself is never persisted", () => {
    const { token, session } = issue();

    expect(session.tokenDigest).not.toBe(token);
    expect(session.tokenDigest).toMatch(/^[0-9a-f]{64}$/);

    const rows = db.$client.query("SELECT * FROM session").all();
    expect(JSON.stringify(rows)).not.toContain(token);
  });

  it("issues unpredictable tokens", () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 200; i++) tokens.add(issue().token);

    expect(tokens.size).toBe(200);
  });

  it("applies the Appendix A sliding expiry per owner kind", () => {
    const now = new Date("2026-03-01T10:00:00Z");
    const { session } = createSession(db, {
      ownerKind: "student",
      ownerId: student.id,
      now,
    });

    expect(session.expiresAt.getTime()).toBe(now.getTime() + STUDENT_SESSION_TTL_DAYS * MS_PER_DAY);
    expect(ttlDaysFor("student")).toBe(14);
    expect(ttlDaysFor("educator")).toBe(EDUCATOR_SESSION_TTL_DAYS);
  });
});

describe("resolveStudentSession", () => {
  it("resolves a live session to its student", () => {
    const { token } = issue();

    expect(resolveStudentSession(db, token)?.student.id).toBe(student.id);
  });

  it("returns null for an unknown token", () => {
    expect(resolveStudentSession(db, "not-a-token")).toBeNull();
  });

  it("returns null once the session has expired", () => {
    const { token } = issue();
    const afterExpiry = new Date(Date.now() + (STUDENT_SESSION_TTL_DAYS + 1) * MS_PER_DAY);

    expect(resolveStudentSession(db, token, afterExpiry)).toBeNull();
  });

  it("slides the expiry forward on each resolution", () => {
    const start = new Date("2026-03-01T10:00:00Z");
    const { token, session } = createSession(db, {
      ownerKind: "student",
      ownerId: student.id,
      now: start,
    });

    const later = new Date(start.getTime() + 3 * MS_PER_DAY);
    resolveStudentSession(db, token, later);

    const stored = db.$client
      .query("SELECT expiresAt FROM session WHERE id = ?")
      .get(session.id) as { expiresAt: number };
    expect(stored.expiresAt).toBe(later.getTime() + STUDENT_SESSION_TTL_DAYS * MS_PER_DAY);
  });

  it("returns null for a disabled student, without waiting for expiry", () => {
    const { token } = issue();
    db.update(studentTable)
      .set({ status: "disabled" })
      .where(eq(studentTable.id, student.id))
      .run();

    expect(resolveStudentSession(db, token)).toBeNull();
  });

  it("refuses to resolve an educator session as a student", () => {
    const { token } = createSession(db, { ownerKind: "educator", ownerId: "educator-1" });

    expect(resolveStudentSession(db, token)).toBeNull();
  });
});

describe("invalidation", () => {
  it("takes effect on the next request after logout", () => {
    const { token } = issue();

    destroySession(db, token);

    expect(resolveStudentSession(db, token)).toBeNull();
  });

  it("force-logout invalidates every session of one student and no other's", () => {
    const first = issue();
    const second = issue();

    const other = createStudent(db, {
      classroomId: student.classroomId,
      label: "quiet-heron",
      credentialDigest: "digest-two",
      credentialHint: "EFGH",
    });
    const otherSession = createSession(db, { ownerKind: "student", ownerId: other.id });

    const count = invalidateAllSessionsFor(db, { ownerKind: "student", ownerId: student.id });

    expect(count).toBe(2);
    expect(resolveStudentSession(db, first.token)).toBeNull();
    expect(resolveStudentSession(db, second.token)).toBeNull();
    expect(resolveStudentSession(db, otherSession.token)).not.toBeNull();
  });
});
