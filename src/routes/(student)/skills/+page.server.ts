import { error, fail as kitFail } from "@sveltejs/kit";
import { fail, superValidate } from "sveltekit-superforms";
import { valibot } from "sveltekit-superforms/adapters";
import * as v from "valibot";
import { requireStudentPage } from "$lib/server/auth/guards";
import { getDb } from "$lib/server/boot";
import { SkillIdSchema, SkillSchema, SkillStateSchema } from "$lib/server/classroom/schemas";
import { getClassroom } from "$lib/server/db/queries/classrooms";
import {
  createSkill,
  deleteSkill,
  getOwnedSkill,
  listStudentSkills,
  updateSkill,
} from "$lib/server/db/queries/skills";
import type { SkillAuthoringPolicy } from "$lib/server/db/schema";
import type { Actions, PageServerLoad } from "./$types";

/**
 * Student skill authoring (PRD §12, §21).
 *
 * "Students may author skills. Writing a skill, observing how the model's
 * behaviour changes, and iterating is among the better available lessons in how
 * these systems work. Student-authored skills apply only to that student's
 * conversations."
 *
 * Two things are enforced here and nowhere else: the classroom's authoring
 * policy, and ownership. A pupil in a class that has switched authoring off is
 * refused at the action, not merely shown no form (§8, §21); and every read and
 * write goes through an owner-scoped query, so another pupil's skill is absent
 * rather than forbidden.
 */

const adapter = valibot(SkillSchema);

/** The classroom's policy, resolved once per request. */
function policyFor(classroomId: string): SkillAuthoringPolicy {
  return getClassroom(getDb(), classroomId)?.skillAuthoringPolicy ?? "disabled";
}

/**
 * Whether a new or edited version needs approval before it applies (§12).
 *
 * "New and edited versions sit inactive until the educator approves them" — so
 * an edit under this policy moves an approved skill back to pending, which is
 * what makes it a review of the text rather than of the author.
 */
function approvalFor(policy: SkillAuthoringPolicy) {
  return policy === "pre-approval" ? ("pending" as const) : ("approved" as const);
}

export const load: PageServerLoad = async ({ locals }) => {
  const student = requireStudentPage(locals);

  return {
    policy: policyFor(student.classroomId),
    form: await superValidate(adapter, { id: "skill" }),
    skills: listStudentSkills(getDb(), student.id).map((skill) => ({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      body: skill.body,
      enabled: skill.enabled,
      approvalState: skill.approvalState,
    })),
  };
};

export const actions: Actions = {
  save: async ({ request, locals }) => {
    const student = requireStudentPage(locals);
    const policy = policyFor(student.classroomId);
    if (policy === "disabled") error(403, "Not allowed");

    const body = await request.formData();
    const existing = v.safeParse(SkillIdSchema, { skillId: body.get("skillId") ?? undefined });

    const form = await superValidate(body, adapter, { id: "skill" });
    if (!form.valid) return fail(400, { form });

    if (existing.success) {
      // Owner-scoped: a pupil editing an identifier that is not theirs finds
      // nothing, rather than being told it exists (§21).
      if (!getOwnedSkill(getDb(), { skillId: existing.output.skillId, studentId: student.id })) {
        error(404, "Not found");
      }

      updateSkill(getDb(), {
        skillId: existing.output.skillId,
        ...form.data,
        approvalState: approvalFor(policy),
      });
      return { form };
    }

    createSkill(getDb(), {
      origin: "student",
      ownerStudentId: student.id,
      ...form.data,
      // A pupil's own skill starts switched on: they wrote it deliberately, and
      // the gate that matters under pre-approval is the approval state (§12).
      enabled: true,
      approvalState: approvalFor(policy),
    });

    return { form };
  },

  setEnabled: async ({ request, locals }) => {
    const student = requireStudentPage(locals);
    if (policyFor(student.classroomId) === "disabled") error(403, "Not allowed");

    const body = await request.formData();
    const parsed = v.safeParse(SkillStateSchema, {
      skillId: body.get("skillId"),
      enabled: body.get("enabled") ?? undefined,
    });
    if (!parsed.success || parsed.output.enabled === undefined) {
      return kitFail(400, { invalid: true });
    }
    if (!getOwnedSkill(getDb(), { skillId: parsed.output.skillId, studentId: student.id })) {
      error(404, "Not found");
    }

    updateSkill(getDb(), {
      skillId: parsed.output.skillId,
      enabled: parsed.output.enabled === "true",
    });
    return { saved: true };
  },

  delete: async ({ request, locals }) => {
    const student = requireStudentPage(locals);

    const body = await request.formData();
    const parsed = v.safeParse(SkillIdSchema, { skillId: body.get("skillId") });
    if (!parsed.success) return kitFail(400, { invalid: true });
    if (!getOwnedSkill(getDb(), { skillId: parsed.output.skillId, studentId: student.id })) {
      error(404, "Not found");
    }

    deleteSkill(getDb(), parsed.output.skillId);
    return { deleted: true };
  },
};
