import { fail as kitFail } from "@sveltejs/kit";
import { fail, superValidate } from "sveltekit-superforms";
import { valibot } from "sveltekit-superforms/adapters";
import * as v from "valibot";
import { requireEducatorPage } from "$lib/server/auth/guards";
import { getDb } from "$lib/server/boot";
import { SkillIdSchema, SkillSchema, SkillStateSchema } from "$lib/server/classroom/schemas";
import {
  createSkill,
  deleteSkill,
  getSkill,
  listLibrarySkills,
  updateSkill,
} from "$lib/server/db/queries/skills";
import { importSkill, searchRegistry } from "$lib/server/skills/import";
import { parseSkillFile } from "$lib/server/skills/uploads";
import type { Actions, PageServerLoad } from "./$types";

/**
 * The educator's skill library (PRD §12, §17, §21).
 *
 * "The educator has complete control of the library. Library skills are authored
 * in the panel, uploaded as files, or imported from the skills.sh registry."
 *
 * Three ways in, one rule out: text that did not come from this form arrives
 * disabled. The upload and import actions below therefore pass no enablement at
 * all and let the column default hold — an omission that is the security
 * property, so it is stated rather than implied (§12, §21).
 */

const adapter = valibot(SkillSchema);

/** A library skill only: a pupil's own skill is not editable from this page (§21). */
function librarySkill(skillId: string) {
  const skill = getSkill(getDb(), skillId);
  return skill && skill.ownerStudentId === null ? skill : null;
}

export const load: PageServerLoad = async ({ locals }) => {
  requireEducatorPage(locals);

  return {
    form: await superValidate(adapter, { id: "skill" }),
    skills: listLibrarySkills(getDb()).map((skill) => ({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      origin: skill.origin,
      enabled: skill.enabled,
      body: skill.body,
    })),
  };
};

export const actions: Actions = {
  /** Author a skill here. Panel-authored text is the educator's own, so it is on. */
  create: async ({ request, locals }) => {
    requireEducatorPage(locals);

    const form = await superValidate(request, adapter, { id: "skill" });
    if (!form.valid) return fail(400, { form });

    createSkill(getDb(), { origin: "panel", ...form.data, enabled: true });
    return { form };
  },

  /**
   * Upload a skill file (§12, §21).
   *
   * The text is untrusted: it is parsed, never executed, and no `enabled` is
   * passed — it arrives switched off and waits for an explicit enable.
   */
  upload: async ({ request, locals }) => {
    requireEducatorPage(locals);

    const body = await request.formData();
    const file = body.get("file");
    if (!(file instanceof File)) return kitFail(400, { invalid: true });

    const parsed = parseSkillFile(file.name, await file.text());
    if (!parsed.ok) return kitFail(422, { uploadFailed: true });

    createSkill(getDb(), { origin: "upload", ...parsed.skill });
    return { uploaded: true };
  },

  /** Browse the registry server-side; a failure degrades to the upload form (§12). */
  search: async ({ request, locals }) => {
    requireEducatorPage(locals);

    const body = await request.formData();
    const query = String(body.get("query") ?? "").slice(0, 100);

    const result = await searchRegistry(query);
    if (!result.ok) return kitFail(503, { registryUnavailable: true });

    return { entries: result.value };
  },

  /** Import one registry entry. Untrusted text, so it arrives switched off (§12, §21). */
  import: async ({ request, locals }) => {
    requireEducatorPage(locals);

    const body = await request.formData();
    const id = String(body.get("entryId") ?? "").slice(0, 200);
    if (!id) return kitFail(400, { invalid: true });

    const result = await importSkill(id);
    if (!result.ok) return kitFail(503, { registryUnavailable: true });

    createSkill(getDb(), { origin: "import", ...result.value });
    return { imported: true };
  },

  /** The explicit educator action that makes an uploaded or imported skill live (§12). */
  setState: async ({ request, locals }) => {
    requireEducatorPage(locals);

    const body = await request.formData();
    const parsed = v.safeParse(SkillStateSchema, {
      skillId: body.get("skillId"),
      enabled: body.get("enabled") ?? undefined,
    });
    if (!parsed.success || parsed.output.enabled === undefined) {
      return kitFail(400, { invalid: true });
    }
    if (!librarySkill(parsed.output.skillId)) return kitFail(404, { invalid: true });

    updateSkill(getDb(), {
      skillId: parsed.output.skillId,
      enabled: parsed.output.enabled === "true",
    });
    return { saved: true };
  },

  delete: async ({ request, locals }) => {
    requireEducatorPage(locals);

    const body = await request.formData();
    const parsed = v.safeParse(SkillIdSchema, { skillId: body.get("skillId") });
    if (!parsed.success) return kitFail(400, { invalid: true });
    if (!librarySkill(parsed.output.skillId)) return kitFail(404, { invalid: true });

    deleteSkill(getDb(), parsed.output.skillId);
    return { deleted: true };
  },
};
