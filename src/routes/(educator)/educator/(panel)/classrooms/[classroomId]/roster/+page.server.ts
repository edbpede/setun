import { error, fail } from "@sveltejs/kit";
import * as v from "valibot";
import type { CredentialCard } from "$lib/credentials";
import { requireEducatorPage } from "$lib/server/auth/guards";
import { provisionStudents, rotateStudentCredential } from "$lib/server/auth/provisioning";
import { getDb, getFileStore } from "$lib/server/boot";
import { resolveRoster } from "$lib/server/classroom/roster";
import {
  DeleteStudentSchema,
  ProvisionSchema,
  StudentAttachmentsSchema,
  StudentIdSchema,
  StudentInstructionsSchema,
  StudentStatusSchema,
} from "$lib/server/classroom/schemas";
import {
  changeStudentStatus,
  clearDisplayName,
  overrideAttachments,
  purgeStudent,
} from "$lib/server/classroom/students";
import { getConfig } from "$lib/server/config";
import { getClassroom } from "$lib/server/db/queries/classrooms";
import { getStudentById, setStudentInstructions } from "$lib/server/db/queries/students";
import type { Actions, PageServerLoad } from "./$types";

/**
 * The roster, and provisioning (PRD §7, §16, §17).
 *
 * "Roster: per-student status, usage and allowance (with cost estimate), last
 * activity, per-student instructions and attachment overrides, with disable,
 * enable, rotate credential, clear display name, remove, and delete actions.
 * Provisioning: batch creation of pseudonymous accounts… and printable
 * credential cards."
 *
 * Two rules govern this file. Every write is classroom-scoped in SQL, so an
 * educator's URL cannot reach a pupil in another class (§21). And a plaintext
 * access code exists only in the response that mints it: it is returned to be
 * printed, never stored, never logged, and gone on the next navigation (§7).
 */

function classroomFor(classroomId: string) {
  const classroom = getClassroom(getDb(), classroomId);
  if (!classroom) error(404, "Not found");
  return classroom;
}

export const load: PageServerLoad = ({ params, url }) => {
  const classroom = classroomFor(params.classroomId);
  const includeRemoved = url.searchParams.get("removed") === "1";

  return {
    includeRemoved,
    students: resolveRoster(getDb(), classroom, new Date(), { includeRemoved }),
  };
};

export const actions: Actions = {
  /**
   * Create a batch of pseudonymous accounts, and hand back their cards (§7, §17).
   *
   * The codes travel in the action result and are rendered once. There is no
   * route that can show them again, because there is nothing stored to show.
   */
  provision: async ({ request, params, locals }) => {
    requireEducatorPage(locals);
    const classroom = classroomFor(params.classroomId);

    const parsed = v.safeParse(ProvisionSchema, { count: (await request.formData()).get("count") });
    if (!parsed.success) return fail(400, { invalid: true });

    const provisioned = await provisionStudents(getDb(), {
      classroomId: classroom.id,
      pepper: getConfig().studentCodePepper,
      count: parsed.output.count,
      // The wordlist follows the classroom's interface language: labels are
      // "speakable in class", which depends on the language spoken there (§17).
      locale: classroom.interfaceLanguage,
    });

    return {
      cards: provisioned.map(
        ({ student, code }): CredentialCard => ({
          label: student.label,
          code: code.display,
          hint: code.hint,
        }),
      ),
    };
  },

  /**
   * Issue a new code, invalidating the pupil's sessions in the same call (§7, §21).
   *
   * Shown once, exactly as at provisioning: "the code is shown at provisioning
   * and rotation only".
   */
  rotate: async ({ request, params, locals }) => {
    requireEducatorPage(locals);
    const classroom = classroomFor(params.classroomId);

    const parsed = v.safeParse(StudentIdSchema, {
      studentId: (await request.formData()).get("studentId"),
    });
    if (!parsed.success) return fail(400, { invalid: true });

    const student = getStudentById(getDb(), parsed.output.studentId);
    const code = await rotateStudentCredential(getDb(), {
      studentId: parsed.output.studentId,
      classroomId: classroom.id,
      pepper: getConfig().studentCodePepper,
    });
    if (!code || !student) return fail(404, { invalid: true });

    return { cards: [{ label: student.label, code: code.display, hint: code.hint }] };
  },

  /** Disable, enable, or remove from the class — the three §16 distinctions bar deletion. */
  setStatus: async ({ request, params, locals }) => {
    requireEducatorPage(locals);
    const classroom = classroomFor(params.classroomId);

    const body = await request.formData();
    const parsed = v.safeParse(StudentStatusSchema, {
      studentId: body.get("studentId"),
      status: body.get("status"),
    });
    if (!parsed.success) return fail(400, { invalid: true });

    const changed = changeStudentStatus(getDb(), {
      studentId: parsed.output.studentId,
      classroomId: classroom.id,
      status: parsed.output.status,
    });
    if (!changed) return fail(404, { invalid: true });

    return { saved: true };
  },

  /** "Optional display names are exactly that" (§16) — an educator can take one off. */
  clearDisplayName: async ({ request, params, locals }) => {
    requireEducatorPage(locals);
    const classroom = classroomFor(params.classroomId);

    const parsed = v.safeParse(StudentIdSchema, {
      studentId: (await request.formData()).get("studentId"),
    });
    if (!parsed.success) return fail(400, { invalid: true });

    if (
      !clearDisplayName(getDb(), { studentId: parsed.output.studentId, classroomId: classroom.id })
    ) {
      return fail(404, { invalid: true });
    }

    return { saved: true };
  },

  /** Per-student attachment override; inherit hands the decision back to the class (§10). */
  setAttachments: async ({ request, params, locals }) => {
    requireEducatorPage(locals);
    const classroom = classroomFor(params.classroomId);

    const body = await request.formData();
    const parsed = v.safeParse(StudentAttachmentsSchema, {
      studentId: body.get("studentId"),
      attachments: body.get("attachments"),
    });
    if (!parsed.success) return fail(400, { invalid: true });

    const changed = overrideAttachments(getDb(), {
      studentId: parsed.output.studentId,
      classroomId: classroom.id,
      attachmentsEnabled:
        parsed.output.attachments === "inherit" ? null : parsed.output.attachments === "on",
    });
    if (!changed) return fail(404, { invalid: true });

    return { saved: true };
  },

  saveInstructions: async ({ request, params, locals }) => {
    requireEducatorPage(locals);
    const classroom = classroomFor(params.classroomId);

    const body = await request.formData();
    const parsed = v.safeParse(StudentInstructionsSchema, {
      studentId: body.get("studentId"),
      instructions: body.get("instructions") ?? undefined,
    });
    if (!parsed.success) return fail(400, { invalid: true });

    const updated = setStudentInstructions(getDb(), {
      studentId: parsed.output.studentId,
      classroomId: classroom.id,
      instructions: parsed.output.instructions,
    });
    if (!updated) return fail(404, { invalid: true });

    return { saved: true };
  },

  /**
   * Permanent deletion (§16).
   *
   * The educator retypes the label. Nothing here is recoverable — the record,
   * the conversations, the attachments, the creations and the search index
   * entries all go — so the distinction from removal is worth a keystroke.
   */
  deleteStudent: async ({ request, params, locals }) => {
    requireEducatorPage(locals);
    const classroom = classroomFor(params.classroomId);

    const body = await request.formData();
    const parsed = v.safeParse(DeleteStudentSchema, {
      studentId: body.get("studentId"),
      confirmLabel: body.get("confirmLabel") ?? "",
    });
    if (!parsed.success) return fail(400, { invalid: true });

    const student = getStudentById(getDb(), parsed.output.studentId);
    if (!student || student.classroomId !== classroom.id) return fail(404, { invalid: true });
    if (student.label !== parsed.output.confirmLabel) {
      return fail(400, { confirmMismatch: parsed.output.studentId });
    }

    await purgeStudent(getDb(), getFileStore(), {
      studentId: parsed.output.studentId,
      classroomId: classroom.id,
    });

    return { deleted: true };
  },
};
