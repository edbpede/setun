import { error, redirect } from "@sveltejs/kit";
import type { Student } from "../db/schema";

/**
 * Route guards (PRD §8, §21).
 *
 * "Enforcement is server-side and applies to every path that can reach a model…
 * Hiding a control in the UI is never treated as access control."
 *
 * Two shapes, because the correct answer differs: a page sends the student to
 * the login screen, an endpoint refuses. Both derive from the same resolved
 * session — neither trusts anything the client sent.
 */

/** For page loads and form actions: redirect an unauthenticated visitor to login. */
export function requireStudentPage(locals: App.Locals): Student {
  if (!locals.student) redirect(303, "/login");
  return locals.student;
}

/**
 * For API endpoints: refuse without a redirect.
 *
 * The message is deliberately generic — an endpoint distinguishing "no session"
 * from "wrong owner" would let a caller probe for other students' resources (§21).
 */
export function requireStudentApi(locals: App.Locals): Student {
  if (!locals.student) error(401, "Not signed in");
  return locals.student;
}
