import type { AppDatabase } from "../db/client";
import { studentFiles } from "../db/queries/retention";
import { removeStudentFromIndex } from "../db/queries/search";
import { invalidateOwnerSessions } from "../db/queries/sessions";
import {
  clearStudentDisplayName,
  deleteStudent,
  setStudentAttachments,
  setStudentStatus,
} from "../db/queries/students";
import type { StudentStatus } from "../db/schema";
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
  for (const file of doomed) await files.remove(file.storagePath);

  return true;
}
