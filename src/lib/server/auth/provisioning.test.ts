import { beforeEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import type { AppDatabase } from "../db/client";
import { createClassroom } from "../db/queries/classrooms";
import { getStudentById, setStudentStatus } from "../db/queries/students";
import { session } from "../db/schema";
import { createTestDatabase } from "../db/testing";
import { attemptStudentLogin } from "./login";
import {
  provisionStudent,
  rotateActiveClassroomCredentials,
  rotateStudentCredential,
} from "./provisioning";
import { createSession, resolveStudentSession } from "./sessions";

const PEPPER = "test-pepper-not-a-real-secret";

let db: AppDatabase;

beforeEach(() => {
  db = createTestDatabase();
});

describe("active-classroom credential rotation", () => {
  it("rotates only active students in the selected classroom and revokes their sessions", async () => {
    const classroom = createClassroom(db, { name: "7.B" });
    const otherClassroom = createClassroom(db, { name: "8.A" });
    const first = await provisionStudent(db, { classroomId: classroom.id, pepper: PEPPER });
    const second = await provisionStudent(db, { classroomId: classroom.id, pepper: PEPPER });
    const disabled = await provisionStudent(db, { classroomId: classroom.id, pepper: PEPPER });
    const removed = await provisionStudent(db, { classroomId: classroom.id, pepper: PEPPER });
    const other = await provisionStudent(db, { classroomId: otherClassroom.id, pepper: PEPPER });

    setStudentStatus(db, {
      studentId: disabled.student.id,
      classroomId: classroom.id,
      status: "disabled",
    });
    setStudentStatus(db, {
      studentId: removed.student.id,
      classroomId: classroom.id,
      status: "removed",
    });

    const firstSession = createSession(db, { ownerKind: "student", ownerId: first.student.id });
    const secondSession = createSession(db, { ownerKind: "student", ownerId: second.student.id });
    const otherSession = createSession(db, { ownerKind: "student", ownerId: other.student.id });
    const untouched = [disabled, removed, other].map(
      ({ student }) => getStudentById(db, student.id)?.credentialDigest,
    );

    const result = await rotateActiveClassroomCredentials(db, {
      classroomId: classroom.id,
      pepper: PEPPER,
    });

    expect(result.status).toBe("rotated");
    expect(result.students.map(({ student }) => student.id).sort()).toEqual(
      [first.student.id, second.student.id].sort(),
    );
    expect(resolveStudentSession(db, firstSession.token)).toBeNull();
    expect(resolveStudentSession(db, secondSession.token)).toBeNull();
    expect(resolveStudentSession(db, otherSession.token)).not.toBeNull();
    expect(
      [disabled, removed, other].map(
        ({ student }) => getStudentById(db, student.id)?.credentialDigest,
      ),
    ).toEqual(untouched);
  });

  it("retires every old code and accepts every returned replacement", async () => {
    const classroom = createClassroom(db, { name: "7.B" });
    const students = await Promise.all(
      Array.from({ length: 3 }, () =>
        provisionStudent(db, { classroomId: classroom.id, pepper: PEPPER }),
      ),
    );

    const result = await rotateActiveClassroomCredentials(db, {
      classroomId: classroom.id,
      pepper: PEPPER,
    });
    expect(result.status).toBe("rotated");

    for (const [index, old] of students.entries()) {
      expect(
        (
          await attemptStudentLogin(db, {
            code: old.code.normalised,
            ip: `203.0.113.${index + 1}`,
            pepper: PEPPER,
          })
        ).ok,
      ).toBe(false);
    }
    for (const [index, replacement] of result.students.entries()) {
      expect(
        (
          await attemptStudentLogin(db, {
            code: replacement.code.normalised,
            ip: `198.51.100.${index + 1}`,
            pepper: PEPPER,
          })
        ).ok,
      ).toBe(true);
    }
  });

  it("returns empty without changing anything when no active student is eligible", async () => {
    const classroom = createClassroom(db, { name: "7.B" });
    const disabled = await provisionStudent(db, { classroomId: classroom.id, pepper: PEPPER });
    setStudentStatus(db, {
      studentId: disabled.student.id,
      classroomId: classroom.id,
      status: "disabled",
    });

    expect(
      await rotateActiveClassroomCredentials(db, {
        classroomId: classroom.id,
        pepper: PEPPER,
      }),
    ).toEqual({ status: "empty", students: [] });
  });

  it("aborts without a partial rotation when the active-roster snapshot changes", async () => {
    const classroom = createClassroom(db, { name: "7.B" });
    const first = await provisionStudent(db, { classroomId: classroom.id, pepper: PEPPER });
    const second = await provisionStudent(db, { classroomId: classroom.id, pepper: PEPPER });
    const before = [first, second].map(
      ({ student }) => getStudentById(db, student.id)?.credentialDigest,
    );

    const pending = rotateActiveClassroomCredentials(db, {
      classroomId: classroom.id,
      pepper: PEPPER,
    });
    setStudentStatus(db, {
      studentId: second.student.id,
      classroomId: classroom.id,
      status: "disabled",
    });

    expect(await pending).toEqual({ status: "stale", students: [] });
    expect(
      [first, second].map(({ student }) => getStudentById(db, student.id)?.credentialDigest),
    ).toEqual(before);
    expect(db.select().from(session).where(eq(session.ownerKind, "student")).all()).toHaveLength(0);
  });
});

describe("single-student credential rotation", () => {
  it("cannot rotate or revoke a student through another classroom", async () => {
    const classroom = createClassroom(db, { name: "7.B" });
    const otherClassroom = createClassroom(db, { name: "8.A" });
    const provisioned = await provisionStudent(db, { classroomId: classroom.id, pepper: PEPPER });
    const live = createSession(db, { ownerKind: "student", ownerId: provisioned.student.id });
    const before = getStudentById(db, provisioned.student.id)?.credentialDigest;

    expect(
      await rotateStudentCredential(db, {
        studentId: provisioned.student.id,
        classroomId: otherClassroom.id,
        pepper: PEPPER,
      }),
    ).toBeNull();
    expect(getStudentById(db, provisioned.student.id)?.credentialDigest).toBe(before);
    expect(resolveStudentSession(db, live.token)).not.toBeNull();
  });
});
