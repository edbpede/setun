import { redirect } from "@sveltejs/kit";
import { fail, superValidate } from "sveltekit-superforms";
import { valibot } from "sveltekit-superforms/adapters";
import { requireEducatorPage } from "$lib/server/auth/guards";
import { destroySession, EDUCATOR_SESSION_COOKIE_NAME } from "$lib/server/auth/sessions";
import { getDb, getGatewayAdapter } from "$lib/server/boot";
import { CreateClassroomSchema } from "$lib/server/classroom/schemas";
import { createClassroom } from "$lib/server/db/queries/classrooms";
import { checkGatewayHealth } from "$lib/server/gateway/health";
import type { Actions, PageServerLoad } from "./$types";

/**
 * The panel entry: create a classroom, and see whether the gateway is answering
 * (PRD §9, §17).
 *
 * Thin by §6.1: authorise, validate, delegate, redirect. Every action re-checks
 * the educator role — the layout's load does not run before an action, so a
 * guard that lived only there would leave this unguarded (§21).
 */

const adapter = valibot(CreateClassroomSchema);

export const load: PageServerLoad = async () => ({
  form: await superValidate(adapter),
  gateway: await checkGatewayHealth(getGatewayAdapter()),
});

export const actions: Actions = {
  create: async ({ request, locals }) => {
    requireEducatorPage(locals);

    const form = await superValidate(request, adapter);
    if (!form.valid) return fail(400, { form });

    const classroom = createClassroom(getDb(), form.data);
    redirect(303, `/educator/classrooms/${classroom.id}`);
  },

  logout: async ({ cookies }) => {
    const token = cookies.get(EDUCATOR_SESSION_COOKIE_NAME);
    if (token) destroySession(getDb(), token);
    cookies.delete(EDUCATOR_SESSION_COOKIE_NAME, { path: "/" });

    redirect(303, "/educator/login");
  },
};
