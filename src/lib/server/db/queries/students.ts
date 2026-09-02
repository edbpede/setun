import { and, asc, eq, inArray, max, ne } from "drizzle-orm";
import type { AppDatabase } from "../client";
import {
  type InterfaceLanguage,
  type Student,
  type StudentStatus,
  session,
  student,
} from "../schema";

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

/**
 * The classroom's roster.
 *
 * Removed pupils are off it by default: §16 asks that removal from a class be
 * distinct from disabling and from permanent deletion, and a removed record that
 * kept appearing beside the active ones would collapse the first distinction.
 * Their work is untouched, and `includeRemoved` brings them back into view.
 */
export function listClassroomStudents(
  db: AppDatabase,
  classroomId: string,
  options: { includeRemoved?: boolean } = {},
): Student[] {
  return (
    db
      .select()
      .from(student)
      .where(
        options.includeRemoved
          ? eq(student.classroomId, classroomId)
          : and(eq(student.classroomId, classroomId), ne(student.status, "removed")),
      )
      // Ordered explicitly: labels are unique within a classroom, so this is a
      // stable order an educator can scan, and without it SQLite is free to
      // return whichever order its chosen index happens to produce.
      .orderBy(asc(student.label))
      .all()
  );
}

/**
 * When each of these pupils was last seen (§17).
 *
 * "Roster: per-student status, usage and allowance… last activity". Read from
 * the session rows rather than from a column on the pupil: every authenticated
 * request already slides the session's expiry, so the fact is recorded once and
 * this reads it, instead of a second write on every request that could drift.
 */
export function lastActivityByStudent(
  db: AppDatabase,
  studentIds: readonly string[],
): Map<string, Date> {
  if (studentIds.length === 0) return new Map();

  const rows = db
    .select({ ownerId: session.ownerId, lastSeenAt: max(session.lastSeenAt) })
    .from(session)
    .where(and(eq(session.ownerKind, "student"), inArray(session.ownerId, [...studentIds])))
    .groupBy(session.ownerId)
    .all();

  return new Map(
    rows.flatMap((row) =>
      row.lastSeenAt ? [[row.ownerId, new Date(row.lastSeenAt)] as const] : [],
    ),
  );
}

/**
 * Move a pupil between roster states (§16, §17).
 *
 * Classroom-scoped in the statement, so an educator's URL cannot reach a pupil
 * in another class (§21). Invalidating sessions is the caller's job and is not
 * optional for a state that must stop a pupil now — `classroom/roster` does both.
 */
export function setStudentStatus(
  db: AppDatabase,
  input: { studentId: string; classroomId: string; status: StudentStatus },
): Student | undefined {
  const [row] = db
    .update(student)
    .set({ status: input.status, updatedAt: new Date() })
    .where(and(eq(student.id, input.studentId), eq(student.classroomId, input.classroomId)))
    .returning()
    .all();
  return row;
}

/**
 * Clear the optional display name (§16, §17).
 *
 * "Optional display names are exactly that" — an educator can take one off
 * without touching the account, and the pseudonymous label remains.
 */
export function clearStudentDisplayName(
  db: AppDatabase,
  input: { studentId: string; classroomId: string },
): Student | undefined {
  const [row] = db
    .update(student)
    .set({ displayName: null, updatedAt: new Date() })
    .where(and(eq(student.id, input.studentId), eq(student.classroomId, input.classroomId)))
    .returning()
    .all();
  return row;
}

/** The pupil's own display name, set or cleared from their dashboard (§18). */
export function setStudentDisplayName(
  db: AppDatabase,
  input: { studentId: string; displayName: string | null },
): void {
  db.update(student)
    .set({ displayName: input.displayName, updatedAt: new Date() })
    .where(eq(student.id, input.studentId))
    .run();
}

/** Per-student attachment override; null follows the classroom (§10, §17). */
export function setStudentAttachments(
  db: AppDatabase,
  input: { studentId: string; classroomId: string; attachmentsEnabled: boolean | null },
): Student | undefined {
  const [row] = db
    .update(student)
    .set({ attachmentsEnabled: input.attachmentsEnabled, updatedAt: new Date() })
    .where(and(eq(student.id, input.studentId), eq(student.classroomId, input.classroomId)))
    .returning()
    .all();
  return row;
}

/**
 * Permanent deletion (§16).
 *
 * The third of the three distinctions: the row goes, and conversations,
 * messages, attachments, artifacts, images, sessions and skills go with it
 * through the schema cascades. There is no undo, which is why it is a separate
 * action from removal rather than a stronger form of it.
 */
export function deleteStudent(
  db: AppDatabase,
  input: { studentId: string; classroomId: string },
): boolean {
  return (
    db
      .delete(student)
      .where(and(eq(student.id, input.studentId), eq(student.classroomId, input.classroomId)))
      .returning({ id: student.id })
      .all().length > 0
  );
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
