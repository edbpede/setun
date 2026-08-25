import { redirect } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";

/**
 * The root, which nobody stays on (PRD §17, §18).
 *
 * Setun has two audiences and each has a home: a pupil's is their dashboard, an
 * educator's is the panel, and a visitor with neither session is asked for a
 * code. There is nothing a landing page here could add that the destination does
 * not say better.
 *
 * Resolved from the session on the server, so an unauthenticated visitor never
 * learns which of the two exists (§21).
 */
export const load: PageServerLoad = ({ locals }) => {
  if (locals.student) redirect(303, "/dashboard");
  if (locals.educator) redirect(303, "/educator");
  redirect(303, "/login");
};
