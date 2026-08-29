import type { AppDatabase } from "../db/client";
import { countArtifacts } from "../db/queries/artifacts";
import { deleteClassroom } from "../db/queries/classrooms";
import { countConversations } from "../db/queries/conversations";
import { type DoomedFile, studentFiles } from "../db/queries/retention";
import { removeStudentFromIndex } from "../db/queries/search";
import { invalidateOwnerSessions } from "../db/queries/sessions";
import {
  clearStudentDisplayName,
  deleteStudent,
  listClassroomStudents,
  setStudentAttachments,
  setStudentStatus,
} from "../db/queries/students";
import type { StudentStatus } from "../db/schema";
import { log } from "../logging";
import type { FileStore } from "../storage/files";

/**
 * The educator's per-student operations (PRD §7, §16, §17, §21).
 *
 * §16 asks the panel to "clearly distinguish disabling, removal from a class,
 * and permanent deletion", and the three differ in exactly the way this module
 * makes explicit:
 *
 * - **disable** — on the roster, cannot sign in, everything kept;
 * - **remove** — off the roster, cannot sign in, everything kept;
 * - **delete** — the record and everything that cascades from it are gone.
 *
 * Every write is classroom-scoped in SQL, so an educator's URL cannot reach a
 * pupil in another class (§21), and any state that stops a pupil signing in
 * invalidates their live sessions in the same call: "rotation, disabling, and
 * force-logout invalidate sessions immediately" (§7, §21).
 */

export interface StudentRef {
  readonly studentId: string;
  readonly classroomId: string;
}

/**
 * Remove the bytes whose rows have just cascaded away (§16).
 *
 * `remove` answers whether the bytes are gone, and the retention pass keeps the
 * row when they are not, so the next hourly pass can try again. A purge has no
 * such option — the row naming the path went with the cascade — so a discarded
 * `false` would strand private bytes on the volume with nothing left pointing at
 * them, which is the failure mode §16 is about and the one that looks like
 * success.
 *
 * The line below is therefore the only remaining record of where those bytes
 * are. Storage paths only: a path is an internal identifier, which §16 permits,
 * and never content.
 */
async function removeStoredFiles(files: FileStore, doomed: readonly DoomedFile[]): Promise<void> {
  const stranded: string[] = [];
  for (const file of doomed) {
    if (!(await files.remove(file.storagePath))) stranded.push(file.storagePath);
  }

  if (stranded.length > 0) log.error("purge left stored files behind", { paths: stranded });
}

/** Returns false when the pair names nobody — which is what the route turns into a 404. */
export function changeStudentStatus(
  db: AppDatabase,
  input: StudentRef & { status: StudentStatus },
): boolean {
  const updated = setStudentStatus(db, input);
  if (!updated) return false;

  // Anything but `active` must take effect now, not when a cookie lapses (§21).
  if (input.status !== "active") {
    invalidateOwnerSessions(db, { ownerKind: "student", ownerId: input.studentId });
  }

  return true;
}

export function clearDisplayName(db: AppDatabase, input: StudentRef): boolean {
  return clearStudentDisplayName(db, input) !== undefined;
}

export function overrideAttachments(
  db: AppDatabase,
  input: StudentRef & { attachmentsEnabled: boolean | null },
): boolean {
  return setStudentAttachments(db, input) !== undefined;
}

/**
 * Permanent deletion (§16).
 *
 * Two things the cascade cannot reach are handled here, and both are handled
 * only after the classroom-scoped delete has confirmed this pupil is in this
 * educator's class — a purge that cleaned up first would act on a pupil the
 * statement then refused to touch (§21):
 *
 * - the search index is a virtual table with no foreign keys, so their text
 *   would stay indexed: stored forever and findable by nobody;
 * - the stored bytes are files, so attachments and generated images would stay
 *   on the volume with nothing left pointing at them.
 */
export async function purgeStudent(
  db: AppDatabase,
  files: FileStore,
  input: StudentRef,
): Promise<boolean> {
  // Read before the delete; the rows naming these paths are about to cascade away.
  const doomed = studentFiles(db, input.studentId);

  if (!deleteStudent(db, input)) return false;

  removeStudentFromIndex(db, input.studentId);
  await removeStoredFiles(files, doomed);

  return true;
}

/** What a classroom deletion would take with it, for the confirmation (§16). */
export interface ClassroomDeletionScope {
  readonly students: number;
  readonly conversations: number;
  readonly creations: number;
}

/**
 * Count what is about to go, so the educator is told before they confirm (§16).
 *
 * Counts only. Nothing a pupil wrote reaches the panel — §16 gives the educator
 * no interface for that, and "three conversations" is what makes the decision,
 * not what is in them.
 */
export function classroomDeletionScope(
  db: AppDatabase,
  classroomId: string,
): ClassroomDeletionScope {
  const students = listClassroomStudents(db, classroomId, { includeRemoved: true });
  const studentIds = students.map((student) => student.id);

  return {
    students: students.length,
    conversations: studentIds.length === 0 ? 0 : countConversations(db, studentIds),
    creations: studentIds.length === 0 ? 0 : countArtifacts(db, studentIds),
  };
}

/**
 * Permanent deletion of a whole classroom (§16).
 *
 * The container of everything `purgeStudent` deletes, and it cleans up the same
 * two things the cascade cannot reach — the search index and the stored bytes —
 * for every pupil in the room, `includeRemoved` so a pupil taken off the roster
 * is not left behind as orphaned rows and files.
 *
 * Both are read before the delete, because the rows naming them are about to
 * cascade away, and both are applied after it, so a refused delete leaves
 * nothing half-removed.
 *
 * Returns false when no such classroom exists.
 */
export async function purgeClassroom(
  db: AppDatabase,
  files: FileStore,
  classroomId: string,
): Promise<boolean> {
  const students = listClassroomStudents(db, classroomId, { includeRemoved: true });
  const doomed = students.flatMap((student) => studentFiles(db, student.id));

  if (!deleteClassroom(db, classroomId)) return false;

  for (const student of students) removeStudentFromIndex(db, student.id);
  await removeStoredFiles(files, doomed);

  return true;
}
