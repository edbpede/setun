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

/**
 * Provision a batch (§17).
 *
 * "Provisioning: batch creation of pseudonymous accounts — labels are generated
 * word pairs from a localised wordlist shipped in the repository, unique within
 * a classroom, speakable in class — and printable credential cards."
 *
 * Sequential rather than concurrent: uniqueness within the classroom is decided
 * against the labels already taken, and two parallel calls would read the same
 * set and could pick the same pair.
 */
export async function provisionStudents(
  db: AppDatabase,
  input: { classroomId: string; pepper: string; count: number; locale?: WordlistLocale },
): Promise<ProvisionedStudent[]> {
  const provisioned: ProvisionedStudent[] = [];
  for (let i = 0; i < input.count; i++) {
    provisioned.push(await provisionStudent(db, input));
  }
  return provisioned;
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
  input: { studentId: string; classroomId: string; pepper: string },
): Promise<GeneratedCode | null> {
  const code = generateCode();

  // Classroom-scoped: an educator's URL must not be a way to reissue a code for
  // a pupil in another class, and a mismatched pair updates nothing (§21).
  const updated = updateStudentCredential(db, {
    studentId: input.studentId,
    classroomId: input.classroomId,
    credentialDigest: await digestCode(code.normalised, input.pepper),
    credentialHint: code.hint,
  });
  if (!updated) return null;

  invalidateAllSessionsFor(db, { ownerKind: "student", ownerId: input.studentId });

  return code;
}
