import { eq } from "drizzle-orm";
import type { AppDatabase } from "../client";
import { type Student, student } from "../schema";

/**
 * Student records (PRD §7, §19).
 *
 * Lookup is by credential digest — the uniquely indexed HMAC of the access code.
 * No function here accepts or returns a plaintext code; the digest is computed
 * by `$lib/server/auth/codes` before it reaches the database (§7, §21).
 */

export function createStudent(
  db: AppDatabase,
  input: { classroomId: string; label: string; credentialDigest: string; credentialHint: string },
): Student {
  const [row] = db.insert(student).values(input).returning().all();
  return row;
}

export function getStudentById(db: AppDatabase, studentId: string): Student | undefined {
  return db.select().from(student).where(eq(student.id, studentId)).get();
}

export function findStudentByDigest(db: AppDatabase, digest: string): Student | undefined {
  return db.select().from(student).where(eq(student.credentialDigest, digest)).get();
}

export function listClassroomStudents(db: AppDatabase, classroomId: string): Student[] {
  return db.select().from(student).where(eq(student.classroomId, classroomId)).all();
}

/**
 * Replace the credential (§7).
 *
 * Invalidating the student's sessions is the caller's job and is not optional —
 * rotation invalidates immediately (§21). `auth/provisioning` does both.
 */
export function updateStudentCredential(
  db: AppDatabase,
  input: { studentId: string; credentialDigest: string; credentialHint: string },
): void {
  db.update(student)
    .set({
      credentialDigest: input.credentialDigest,
      credentialHint: input.credentialHint,
      updatedAt: new Date(),
    })
    .where(eq(student.id, input.studentId))
    .run();
}
