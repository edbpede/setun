import { requireEducatorPage } from "$lib/server/auth/guards";
import { getDb } from "$lib/server/boot";
import { listClassrooms } from "$lib/server/db/queries/classrooms";
import type { LayoutServerLoad } from "./$types";

/**
 * The panel's guard (PRD §7, §21).
 *
 * "Educator endpoints require an educator role." Every page under this layout
 * passes through here, and each action re-checks for itself: a layout load does
 * not run before a form action, so a guard that only lived here would leave
 * every action unguarded (§21).
 *
 * The sign-in page sits outside this group deliberately — a guard that redirected
 * the login route to itself would loop.
 */
export const load: LayoutServerLoad = ({ locals }) => {
  const educator = requireEducatorPage(locals);

  return {
    educator: { username: educator.username },
    classrooms: listClassrooms(getDb()).map((classroom) => ({
      id: classroom.id,
      name: classroom.name,
      state: classroom.state,
    })),
  };
};
