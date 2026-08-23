import { error, redirect } from "@sveltejs/kit";
import type { Educator, Student } from "../db/schema";

/**
 * Route guards (PRD §8, §21).
 *
 * "Enforcement is server-side and applies to every path that can reach a model…
 * Hiding a control in the UI is never treated as access control."
 *
 * Two shapes per role, because the correct answer differs: a page sends the
 * visitor to the login screen, an endpoint refuses. Both derive from the
 * resolved session — neither trusts anything the client sent.
 */

// --- Student guards ---

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

// --- Educator guards ---

/** For educator page loads: redirect to the educator login. */
export function requireEducatorPage(locals: App.Locals): Educator {
  if (!locals.educator) redirect(303, "/educator/login");
  return locals.educator;
}

/**
 * For educator API endpoints: refuse without a redirect.
 *
 * A student session reaching an educator endpoint is refused identically to an
 * absent session — nothing distinguishes the failure modes (§21).
 */
export function requireEducatorApi(locals: App.Locals): Educator {
  if (!locals.educator) error(401, "Not authorised");
  return locals.educator;
}
