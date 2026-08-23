import { error, fail as kitFail } from "@sveltejs/kit";
import { fail, superValidate } from "sveltekit-superforms";
import { valibot } from "sveltekit-superforms/adapters";
import * as v from "valibot";
import { BUDGET_PRESETS } from "$lib/server/agent/budgets";
import { requireEducatorPage } from "$lib/server/auth/guards";
import { getDb } from "$lib/server/boot";
import { resolveRoster } from "$lib/server/classroom/roster";
import { resolveAvailability, resolveOpenUntil } from "$lib/server/classroom/schedule";
import {
  AliasIdSchema,
  AllowAliasSchema,
  ApplyPresetSchema,
  BudgetsSchema,
  blankToNull,
  ClassroomPolicySchema,
  ScheduleSchema,
  SetStateSchema,
  StudentInstructionsSchema,
  TemporaryWindowsSchema,
} from "$lib/server/classroom/schemas";
import { classroomStateChannel } from "$lib/server/classroom/state-channel";
import {
  allowAlias,
  disallowAlias,
  listAllowedAliasIds,
} from "$lib/server/db/queries/classroom-aliases";
import {
  getClassroom,
  setClassroomState,
  updateClassroomSettings,
} from "$lib/server/db/queries/classrooms";
import { listAliases } from "$lib/server/db/queries/model-aliases";
import { invalidateClassroomSessions } from "$lib/server/db/queries/sessions";
import { setStudentInstructions } from "$lib/server/db/queries/students";
import type { Actions, PageServerLoad } from "./$types";

/**
 * One classroom's configuration (PRD §8, §9, §10, §16, §17).
 *
 * Thin by §6.1 throughout: every action authorises, validates through a Valibot
 * schema, and delegates. The one thing this file decides for itself is *when*
 * connected tabs are told — every write that changes what a pupil may do
 * publishes on the classroom-state channel, so a lock reaches a screen at once
 * (§8).
 */

const budgetsAdapter = valibot(BudgetsSchema);
const policyAdapter = valibot(ClassroomPolicySchema);
const scheduleAdapter = valibot(ScheduleSchema);
const temporaryAdapter = valibot(TemporaryWindowsSchema);

/** Every write here is scoped to a classroom that exists; a stale link is a 404. */
function classroomFor(classroomId: string) {
  const classroom = getClassroom(getDb(), classroomId);
  if (!classroom) error(404, "Not found");
  return classroom;
}

export const load: PageServerLoad = async ({ params }) => {
  const db = getDb();
  const classroom = classroomFor(params.classroomId);
  const allowed = new Set(listAllowedAliasIds(db, classroom.id));

  return {
    classroom,
    availability: resolveAvailability(classroom),
    aliases: listAliases(db).map((alias) => ({
      id: alias.id,
      name: alias.name,
      available: alias.available,
      dataProtection: alias.dataProtection,
      allowed: allowed.has(alias.id),
    })),
    // Account state, counters and the educator's own text — never anything a
    // pupil wrote (§16).
    students: resolveRoster(db, classroom),
    // Seeded field by field rather than from the whole row: the form's shape is
    // the schema's, and a row that grows a column should not silently start
    // feeding it.
    budgetsForm: await superValidate(
      {
        perTurnStepCap: classroom.perTurnStepCap,
        perTurnWallClockSeconds: classroom.perTurnWallClockSeconds,
        perTurnTokenCap: classroom.perTurnTokenCap,
        perStudentDailyTokens: classroom.perStudentDailyTokens,
        perClassroomDailyTokens: classroom.perClassroomDailyTokens,
        costExchangeRate: classroom.costExchangeRate,
      },
      budgetsAdapter,
      { id: "budgets" },
    ),
    policyForm: await superValidate(
      {
        classroomInstructions: classroom.classroomInstructions ?? "",
        interfaceLanguage: classroom.interfaceLanguage,
        sessionPolicy: classroom.sessionPolicy,
        sessionSlidingDays: classroom.sessionSlidingDays,
        permissionMode: classroom.permissionMode,
        skillAuthoringPolicy: classroom.skillAuthoringPolicy,
        conversationRetentionDays: classroom.conversationRetentionDays,
        attachmentsEnabled: classroom.attachmentsEnabled,
      },
      policyAdapter,
      { id: "policy" },
    ),
    scheduleForm: await superValidate(
      { weeklySchedule: classroom.weeklySchedule },
      scheduleAdapter,
      { id: "schedule" },
    ),
    temporaryForm: await superValidate(
      { temporaryWindows: classroom.temporaryWindows },
      temporaryAdapter,
      { id: "temporary" },
    ),
  };
};

export const actions: Actions = {
  /** Open now, Lock, or hand the room back to its schedule (§8). */
  setState: async ({ request, params, locals }) => {
    requireEducatorPage(locals);
    const classroom = classroomFor(params.classroomId);

    const body = await request.formData();
    const parsed = v.safeParse(SetStateSchema, {
      state: body.get("state"),
      duration: body.get("duration") ?? undefined,
    });
    if (!parsed.success) return kitFail(400, { invalid: true });

    const now = new Date();
    // A lock stands until the educator lifts it; only an Open now carries a
    // duration, and "until the current window ends" is schedule arithmetic (§8).
    const until =
      parsed.output.state === "open"
        ? resolveOpenUntil(classroom, parsed.output.duration, now)
        : null;

    setClassroomState(getDb(), {
      classroomId: classroom.id,
      state: parsed.output.state,
      until,
      now,
    });

    classroomStateChannel.publish(classroom.id);
    return { saved: true };
  },

  saveSchedule: async ({ request, params, locals }) => {
    requireEducatorPage(locals);
    const classroom = classroomFor(params.classroomId);

    const form = await superValidate(request, scheduleAdapter, { id: "schedule" });
    if (!form.valid) return fail(400, { form });

    updateClassroomSettings(getDb(), {
      classroomId: classroom.id,
      settings: { weeklySchedule: form.data.weeklySchedule },
    });

    classroomStateChannel.publish(classroom.id);
    return { form };
  },

  saveTemporaryWindows: async ({ request, params, locals }) => {
    requireEducatorPage(locals);
    const classroom = classroomFor(params.classroomId);

    const form = await superValidate(request, temporaryAdapter, { id: "temporary" });
    if (!form.valid) return fail(400, { form });

    updateClassroomSettings(getDb(), {
      classroomId: classroom.id,
      settings: {
        temporaryWindows: form.data.temporaryWindows.map((window) => ({
          startsAt: window.startsAt,
          endsAt: window.endsAt,
          ...(window.note ? { note: window.note } : {}),
        })),
      },
    });

    classroomStateChannel.publish(classroom.id);
    return { form };
  },

  saveBudgets: async ({ request, params, locals }) => {
    requireEducatorPage(locals);
    const classroom = classroomFor(params.classroomId);

    const form = await superValidate(request, budgetsAdapter, { id: "budgets" });
    if (!form.valid) return fail(400, { form });

    updateClassroomSettings(getDb(), { classroomId: classroom.id, settings: form.data });

    classroomStateChannel.publish(classroom.id);
    return { form };
  },

  /**
   * Fill the five budget fields from a preset (§10, Appendix A).
   *
   * "Selecting a preset fills all five fields; fields remain individually
   * editable afterwards" — so this writes the values and leaves, rather than
   * recording which preset was chosen. A classroom is never in a preset mode.
   */
  applyPreset: async ({ request, params, locals }) => {
    requireEducatorPage(locals);
    const classroom = classroomFor(params.classroomId);

    const body = await request.formData();
    const parsed = v.safeParse(ApplyPresetSchema, { preset: body.get("preset") });
    if (!parsed.success) return kitFail(400, { invalid: true });

    updateClassroomSettings(getDb(), {
      classroomId: classroom.id,
      settings: BUDGET_PRESETS[parsed.output.preset],
    });

    classroomStateChannel.publish(classroom.id);
    return { saved: true };
  },

  savePolicy: async ({ request, params, locals }) => {
    requireEducatorPage(locals);
    const classroom = classroomFor(params.classroomId);

    const form = await superValidate(request, policyAdapter, { id: "policy" });
    if (!form.valid) return fail(400, { form });

    updateClassroomSettings(getDb(), {
      classroomId: classroom.id,
      settings: {
        ...form.data,
        // An empty textarea is an absent layer, not an instruction with no
        // content — the prompt builder must not emit a heading for it (§10).
        classroomInstructions: blankToNull(form.data.classroomInstructions),
      },
    });
    return { form };
  },

  /**
   * Allowlist an alias for this classroom (§8, §9, §16).
   *
   * An alias without a data processing agreement requires the educator's
   * explicit confirmation, and the server refuses without it: §16 asks that the
   * decision be made deliberately by the person accountable, which a dialog the
   * client could skip would not achieve. The confirmation is recorded, not just
   * demanded.
   */
  allowAlias: async ({ request, params, locals }) => {
    requireEducatorPage(locals);
    const classroom = classroomFor(params.classroomId);

    const body = await request.formData();
    const parsed = v.safeParse(AllowAliasSchema, {
      modelAliasId: body.get("modelAliasId"),
      confirmNoDpa: body.get("confirmNoDpa") ?? undefined,
    });
    if (!parsed.success) return kitFail(400, { invalid: true });

    const alias = listAliases(getDb()).find((row) => row.id === parsed.output.modelAliasId);
    if (!alias) return kitFail(404, { invalid: true });

    if (!alias.dataProtection && !parsed.output.confirmNoDpa) {
      return kitFail(400, { needsNoDpaConfirmation: true, modelAliasId: alias.id });
    }

    allowAlias(getDb(), {
      classroomId: classroom.id,
      modelAliasId: alias.id,
      noDpaConfirmedAt: alias.dataProtection ? null : new Date(),
    });

    classroomStateChannel.publish(classroom.id);
    return { saved: true };
  },

  disallowAlias: async ({ request, params, locals }) => {
    requireEducatorPage(locals);
    const classroom = classroomFor(params.classroomId);

    const body = await request.formData();
    const parsed = v.safeParse(AliasIdSchema, { modelAliasId: body.get("modelAliasId") });
    if (!parsed.success) return kitFail(400, { invalid: true });

    disallowAlias(getDb(), { classroomId: classroom.id, modelAliasId: parsed.output.modelAliasId });

    classroomStateChannel.publish(classroom.id);
    return { saved: true };
  },

  /** Bulk session invalidation, immediate (§7, §21). */
  forceLogout: async ({ params, locals }) => {
    requireEducatorPage(locals);
    const classroom = classroomFor(params.classroomId);

    const count = invalidateClassroomSessions(getDb(), classroom.id);
    return { forceLoggedOut: count };
  },

  saveStudentInstructions: async ({ request, params, locals }) => {
    requireEducatorPage(locals);
    const classroom = classroomFor(params.classroomId);

    const body = await request.formData();
    const parsed = v.safeParse(StudentInstructionsSchema, {
      studentId: body.get("studentId"),
      instructions: body.get("instructions") ?? undefined,
    });
    if (!parsed.success) return kitFail(400, { invalid: true });

    // Scoped to this classroom's roster: an educator's URL must not become a way
    // to write instructions onto a pupil in another class (§21).
    const updated = setStudentInstructions(getDb(), {
      studentId: parsed.output.studentId,
      classroomId: classroom.id,
      instructions: parsed.output.instructions,
    });
    if (!updated) return kitFail(404, { invalid: true });

    return { saved: true };
  },
};
