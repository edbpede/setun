import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { AppDatabase } from "../db/client";
import { createStudent, listClassroomStudents } from "../db/queries/students";
import type { Student } from "../db/schema";
import { session, student as studentTable } from "../db/schema";
import { digestCode, type GeneratedCode, generateCode } from "./codes";
import { generateLabel } from "./pseudonyms";
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

export type ClassroomCredentialRotation =
  | { readonly status: "rotated"; readonly students: ProvisionedStudent[] }
  | { readonly status: "empty" | "stale"; readonly students: [] };

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
 *
 * Every code is hashed *before* any row is written, which is what makes the
 * batch a single synchronous turn. A per-pupil `await` in the middle of the
 * writes would let a caller's authorisation be withdrawn between two of them —
 * and half a batch written under an authority that has since moved is exactly
 * the hole `stillAuthorised` exists to close (§21).
 */
export async function provisionStudents(
  db: AppDatabase,
  input: {
    classroomId: string;
    pepper: string;
    count: number;
    locale?: WordlistLocale;
    /**
     * Consulted once, after the hashing and before the first write. One check is
     * enough precisely because the writes below never await: the batch is all or
     * nothing. An empty array means it said no; `count` is at least one wherever
     * this is called from.
     */
    stillAuthorised?: () => boolean;
  },
): Promise<ProvisionedStudent[]> {
  const hashed: { code: GeneratedCode; digest: string }[] = [];
  for (let i = 0; i < input.count; i++) {
    const code = generateCode();
    hashed.push({ code, digest: await digestCode(code.normalised, input.pepper) });
  }

  if (input.stillAuthorised && !input.stillAuthorised()) return [];

  // Read once and carried forward rather than re-read per pupil: within one turn
  // nothing else can write, so the set is exact and the query is not repeated.
  const taken = new Set(listClassroomStudents(db, input.classroomId).map((s) => s.label));

  return hashed.map(({ code, digest }) => {
    const label = generateLabel(input.locale ?? "da", taken);
    taken.add(label);

    return {
      student: createStudent(db, {
        classroomId: input.classroomId,
        label,
        credentialDigest: digest,
        credentialHint: code.hint,
      }),
      code,
    };
  });
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
  const credentialDigest = await digestCode(code.normalised, input.pepper);

  const updated = db.transaction(
    (tx) => {
      // Classroom-scoped: an educator's URL must not be a way to reissue a code
      // for a pupil in another class, and a mismatched pair updates nothing.
      const changed = tx
        .update(studentTable)
        .set({ credentialDigest, credentialHint: code.hint, updatedAt: new Date() })
        .where(
          and(
            eq(studentTable.id, input.studentId),
            eq(studentTable.classroomId, input.classroomId),
          ),
        )
        .returning({ id: studentTable.id })
        .get();
      if (!changed) return false;

      tx.update(session)
        .set({ invalidatedAt: new Date() })
        .where(
          and(
            eq(session.ownerKind, "student"),
            eq(session.ownerId, input.studentId),
            isNull(session.invalidatedAt),
          ),
        )
        .run();
      return true;
    },
    { behavior: "immediate" },
  );
  if (!updated) return null;

  return code;
}

/**
 * Rotate every active credential in one classroom as one all-or-nothing issue.
 *
 * The roster is selected here, never supplied by the browser. Expensive HMACs
 * are prepared before taking SQLite's writer reservation, then an immediate
 * transaction verifies that the active roster and its credentials still match
 * the snapshot before changing any row. A concurrent status or credential
 * change therefore aborts the whole issue instead of producing a mixed sheet.
 */
export async function rotateActiveClassroomCredentials(
  db: AppDatabase,
  input: { classroomId: string; pepper: string },
): Promise<ClassroomCredentialRotation> {
  const snapshot = listClassroomStudents(db, input.classroomId).filter(
    (student) => student.status === "active",
  );
  if (snapshot.length === 0) return { status: "empty", students: [] };

  const prepared = await Promise.all(
    snapshot.map(async (student) => {
      const code = generateCode();
      return {
        student,
        code,
        digest: await digestCode(code.normalised, input.pepper),
      };
    }),
  );

  return db.transaction(
    (tx): ClassroomCredentialRotation => {
      const current = tx
        .select({
          id: studentTable.id,
          label: studentTable.label,
          credentialDigest: studentTable.credentialDigest,
        })
        .from(studentTable)
        .where(
          and(eq(studentTable.classroomId, input.classroomId), eq(studentTable.status, "active")),
        )
        .orderBy(asc(studentTable.label))
        .all();

      const unchanged =
        current.length === snapshot.length &&
        current.every(
          (row, index) =>
            row.id === snapshot[index]?.id &&
            row.label === snapshot[index]?.label &&
            row.credentialDigest === snapshot[index]?.credentialDigest,
        );
      if (!unchanged) return { status: "stale", students: [] };

      const now = new Date();
      for (const item of prepared) {
        tx.update(studentTable)
          .set({ credentialDigest: item.digest, credentialHint: item.code.hint, updatedAt: now })
          .where(
            and(
              eq(studentTable.id, item.student.id),
              eq(studentTable.classroomId, input.classroomId),
              eq(studentTable.status, "active"),
              eq(studentTable.credentialDigest, item.student.credentialDigest),
            ),
          )
          .run();
      }

      tx.update(session)
        .set({ invalidatedAt: now })
        .where(
          and(
            eq(session.ownerKind, "student"),
            isNull(session.invalidatedAt),
            inArray(
              session.ownerId,
              snapshot.map((student) => student.id),
            ),
          ),
        )
        .run();

      return {
        status: "rotated",
        students: prepared.map(({ student, code }) => ({
          student,
          code,
        })),
      };
    },
    { behavior: "immediate" },
  );
}
