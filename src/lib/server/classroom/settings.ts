import type { AppDatabase } from "../db/client";
import { getClassroom } from "../db/queries/classrooms";
import type { Classroom, InterfaceLanguage, ModelAlias, Student } from "../db/schema";
import type { AttachmentPolicy } from "../storage/attachments";

/**
 * Resolved per-student settings (PRD §2, §8, §10).
 *
 * The granularity principle: a classroom sets the policy, and a student may
 * carry an override for the dimensions the PRD names — instructions, interface
 * language, attachments. Resolution happens here, once, rather than at each call
 * site deciding for itself what null means.
 *
 * Instructions are the exception to "override": the two layers *compose* rather
 * than replace, because §10 describes them as successive layers of one prompt —
 * "extra scaffolding for one student" refines the class rule rather than
 * discarding it. So the resolver returns both and the prompt builder layers them.
 */

export interface ResolvedStudentSettings {
  readonly classroomId: string;
  readonly timezone: string;
  /** Layered into the system prompt in order (§10). */
  readonly classroomInstructions: string | null;
  readonly studentInstructions: string | null;
  /** The student's own choice where they made one, else the classroom's (§8, §18). */
  readonly interfaceLanguage: InterfaceLanguage;
  /** Classroom toggle with per-student override (§10). Enforced in Phase 3.11. */
  readonly attachmentsEnabled: boolean;
  readonly attachmentTypes: readonly string[];
}

/** Merge a classroom's settings with one student's overrides. */
export function resolveStudentSettings(
  classroom: Classroom,
  student: Pick<Student, "instructions" | "interfaceLanguage" | "attachmentsEnabled">,
): ResolvedStudentSettings {
  return {
    classroomId: classroom.id,
    timezone: classroom.timezone,
    classroomInstructions: blankToNull(classroom.classroomInstructions),
    studentInstructions: blankToNull(student.instructions),
    interfaceLanguage: student.interfaceLanguage ?? classroom.interfaceLanguage,
    attachmentsEnabled: student.attachmentsEnabled ?? classroom.attachmentsEnabled,
    attachmentTypes: classroom.attachmentTypes,
  };
}

/**
 * Whitespace-only instructions are absent instructions.
 *
 * An educator who clears the field leaves an empty string behind, and an empty
 * layer reads to a model as an instruction with no content (§10).
 */
function blankToNull(value: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * The attachment policy in force for one student on one conversation (§10).
 *
 * Four sources, one answer: the classroom's toggle and type list, the student's
 * override, the Appendix A caps the classroom may have edited, and the alias's
 * image-input capability flag. The last is why this takes an alias — "attaching
 * an image on a non-capable alias is refused with a friendly message before any
 * gateway call" (§10), and the refusal has to know which model the conversation
 * is on.
 */
export function resolveAttachmentPolicy(
  classroom: Classroom,
  student: Pick<Student, "attachmentsEnabled">,
  alias: Pick<ModelAlias, "supportsImageInput">,
): AttachmentPolicy {
  return {
    enabled: student.attachmentsEnabled ?? classroom.attachmentsEnabled,
    allowedTypes: classroom.attachmentTypes,
    imageMaxBytes: classroom.attachmentImageMaxBytes,
    textMaxBytes: classroom.attachmentTextMaxBytes,
    maxPerMessage: classroom.attachmentMaxPerMessage,
    aliasSupportsImageInput: alias.supportsImageInput,
  };
}

/**
 * The interface language for one student (PRD §8, §18).
 *
 * "Interface language is a classroom setting… and each student may override it
 * for themselves on the dashboard."
 *
 * Returns null when the classroom has gone, which the caller reads as "leave the
 * request's own locale alone" rather than forcing a default onto it.
 */
export function studentInterfaceLanguage(
  db: AppDatabase,
  student: Pick<Student, "classroomId" | "interfaceLanguage">,
): InterfaceLanguage | null {
  if (student.interfaceLanguage) return student.interfaceLanguage;

  const classroom = getClassroom(db, student.classroomId);
  return classroom?.interfaceLanguage ?? null;
}
