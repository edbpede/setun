import type { AppDatabase } from "../db/client";
import {
  createStudent,
  listClassroomStudents,
  updateStudentCredential,
} from "../db/queries/students";
import type { Student } from "../db/schema";
import { digestCode, type GeneratedCode, generateCode } from "./codes";
import { generateLabel } from "./pseudonyms";
import { invalidateAllSessionsFor } from "./sessions";
import type { WordlistLocale } from "./wordlists";

/**
 * Provisioning and rotation (PRD §7).
 *
 * Both operations return the plaintext code exactly once, for the credential
 * card, and never store it. The caller renders it and drops it; there is no way
 * back to it afterwards (§7, §21).
 */

export interface ProvisionedStudent {
  readonly student: Student;
  /** Display this once, then it is gone (§7). */
  readonly code: GeneratedCode;
}

export async function provisionStudent(
  db: AppDatabase,
  input: { classroomId: string; pepper: string; locale?: WordlistLocale },
): Promise<ProvisionedStudent> {
  const taken = new Set(listClassroomStudents(db, input.classroomId).map((s) => s.label));
  const label = generateLabel(input.locale ?? "da", taken);

  const code = generateCode();
  const student = createStudent(db, {
    classroomId: input.classroomId,
    label,
    credentialDigest: await digestCode(code.normalised, input.pepper),
    credentialHint: code.hint,
  });

  return { student, code };
}

/**
 * Issue a new code for an existing student.
 *
 * Existing sessions are invalidated in the same operation — rotation takes
 * effect immediately, not when the old session expires (§7, §21).
 */
export async function rotateStudentCredential(
  db: AppDatabase,
  input: { studentId: string; pepper: string },
): Promise<GeneratedCode> {
  const code = generateCode();

  updateStudentCredential(db, {
    studentId: input.studentId,
    credentialDigest: await digestCode(code.normalised, input.pepper),
    credentialHint: code.hint,
  });
  invalidateAllSessionsFor(db, { ownerKind: "student", ownerId: input.studentId });

  return code;
}
