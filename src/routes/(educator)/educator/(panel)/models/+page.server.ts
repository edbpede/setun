import { fail as kitFail } from "@sveltejs/kit";
import { fail, superValidate } from "sveltekit-superforms";
import { valibot } from "sveltekit-superforms/adapters";
import * as v from "valibot";
import { requireEducatorPage } from "$lib/server/auth/guards";
import { getDb } from "$lib/server/boot";
import { AliasSchema } from "$lib/server/classroom/schemas";
import {
  createAlias,
  deleteAlias,
  designateUtilityAlias,
  listAliases,
  updateAlias,
} from "$lib/server/db/queries/model-aliases";
import type { Actions, PageServerLoad } from "./$types";

/**
 * Model alias management (PRD §9, §17).
 *
 * "Aliases are managed in the educator panel: name, gateway model identifier,
 * dialect, availability, a data-protection flag… and optional per-million-token
 * prices."
 *
 * Thin by §6.1. The one piece of judgement that does not belong in a query
 * module lives here and is one line: designating a utility alias is exclusive,
 * so it goes through `designateUtilityAlias` rather than a plain column write.
 */

const adapter = valibot(AliasSchema);

const AliasIdSchema = v.object({ aliasId: v.pipe(v.string(), v.uuid()) });

export const load: PageServerLoad = async () => ({
  form: await superValidate(adapter),
  aliases: listAliases(getDb()),
});

/** Parse the alias id a row's form carries, refusing anything else (§5). */
async function aliasIdFrom(request: Request): Promise<string | null> {
  const data = await request.formData();
  const parsed = v.safeParse(AliasIdSchema, { aliasId: data.get("aliasId") });
  return parsed.success ? parsed.output.aliasId : null;
}

export const actions: Actions = {
  create: async ({ request, locals }) => {
    requireEducatorPage(locals);

    const form = await superValidate(request, adapter);
    if (!form.valid) return fail(400, { form });

    const alias = createAlias(getDb(), { ...form.data, isUtility: false });
    if (form.data.isUtility) designateUtilityAlias(getDb(), alias.id);

    return { form };
  },

  update: async ({ request, locals }) => {
    requireEducatorPage(locals);

    // The row's own form carries the id alongside the fields, so it is read once
    // from the same body Superforms validates.
    const body = await request.formData();
    const id = v.safeParse(AliasIdSchema, { aliasId: body.get("aliasId") });
    if (!id.success) return kitFail(400, { invalid: true });

    const form = await superValidate(body, adapter);
    if (!form.valid) return fail(400, { form });

    updateAlias(getDb(), {
      aliasId: id.output.aliasId,
      values: { ...form.data, isUtility: false },
    });
    if (form.data.isUtility) designateUtilityAlias(getDb(), id.output.aliasId);

    return { form };
  },

  delete: async ({ request, locals }) => {
    requireEducatorPage(locals);

    const aliasId = await aliasIdFrom(request);
    if (!aliasId) return kitFail(400, { invalid: true });

    deleteAlias(getDb(), aliasId);
    return { deleted: true };
  },
};
