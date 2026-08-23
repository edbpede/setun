import { and, eq } from "drizzle-orm";
import type { AppDatabase } from "../client";
import { type InterfaceLanguage, type Student, student } from "../schema";

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

/**
 * Set or clear a pupil's own instructions (§10).
 *
 * Scoped to a classroom in the statement itself, so a mismatched pair simply
 * updates nothing rather than relying on the caller to have checked — a pupil in
 * another class is not merely refused, they are unreachable (§21).
 *
 * Returns undefined when no row matched, which is what the caller turns into a
 * 404.
 */
export function setStudentInstructions(
  db: AppDatabase,
  input: { studentId: string; classroomId: string; instructions: string | null },
): Student | undefined {
  const [row] = db
    .update(student)
    .set({ instructions: input.instructions, updatedAt: new Date() })
    .where(and(eq(student.id, input.studentId), eq(student.classroomId, input.classroomId)))
    .returning()
    .all();
  return row;
}

/**
 * A pupil's own interface-language override (§8, §18).
 *
 * Null hands the choice back to the classroom setting, which is what "override"
 * means here — the classroom remains the default, not a value that was copied.
 */
export function setStudentInterfaceLanguage(
  db: AppDatabase,
  input: { studentId: string; interfaceLanguage: InterfaceLanguage | null },
): void {
  db.update(student)
    .set({ interfaceLanguage: input.interfaceLanguage, updatedAt: new Date() })
    .where(eq(student.id, input.studentId))
    .run();
}
