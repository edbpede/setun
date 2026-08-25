import { error, fail as kitFail } from "@sveltejs/kit";
import * as v from "valibot";
import { requireEducatorPage } from "$lib/server/auth/guards";
import { getDb } from "$lib/server/boot";
import { resolveClassroomOverview } from "$lib/server/classroom/overview";
import { resolveOpenUntil } from "$lib/server/classroom/schedule";
import { SetStateSchema } from "$lib/server/classroom/schemas";
import { classroomStateChannel } from "$lib/server/classroom/state-channel";
import { getClassroom, setClassroomState } from "$lib/server/db/queries/classrooms";
import type { Actions, PageServerLoad } from "./$types";

/**
 * What is happening in this classroom now (PRD §8, §17).
 *
 * "Dashboard: classroom state, active students, gateway health, current window,
 * usage against budgets and caps, and a one-click lock." This is that view for
 * one room, and it is the page an educator opens between lessons — so
 * availability sits at the top and everything configurable lives a tab away.
 *
 * Thin by §6.1: authorise, validate through a Valibot schema, delegate. Every
 * write that changes what a pupil may do publishes on the classroom-state
 * channel, so a lock reaches a screen at once (§8).
 */

function classroomFor(classroomId: string) {
  const classroom = getClassroom(getDb(), classroomId);
  if (!classroom) error(404, "Not found");
  return classroom;
}

export const load: PageServerLoad = ({ params }) => ({
  overview: resolveClassroomOverview(getDb(), classroomFor(params.classroomId)),
});

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
};
