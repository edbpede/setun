import { error } from "@sveltejs/kit";
import { getDb } from "$lib/server/boot";
import { resolveAvailability } from "$lib/server/classroom/schedule";
import { getClassroom } from "$lib/server/db/queries/classrooms";
import type { LayoutServerLoad } from "./$types";

/**
 * One classroom, resolved once for its three pages (PRD §17).
 *
 * The panel's information architecture splits a classroom into an overview, its
 * settings, and its roster (§17). All three need the same header — the room's
 * name, its timezone, and whether it is open — and resolving that here keeps
 * each page's load to its own concern (§6.1).
 *
 * The educator guard is the panel layout above this one; every action still
 * re-checks for itself, because a layout load does not run before a form action.
 */
export const load: LayoutServerLoad = ({ params }) => {
  const classroom = getClassroom(getDb(), params.classroomId);
  if (!classroom) error(404, "Not found");

  return {
    classroom: {
      id: classroom.id,
      name: classroom.name,
      timezone: classroom.timezone,
      state: classroom.state,
    },
    availability: resolveAvailability(classroom),
  };
};
