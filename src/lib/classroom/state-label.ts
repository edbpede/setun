import * as m from "$lib/paraglide/messages";
import type { AvailabilityStatus } from "$lib/server/classroom/schedule";

/**
 * The words the panel puts on a classroom's state (PRD §8, §17).
 *
 * Read from the *resolved* availability, never from the stored `state` column.
 * An "Open now" override carrying a duration lapses back to the schedule once
 * `stateUntil` passes (§8) — the column still says `open` long after the lesson
 * ended, so a label derived from it tells the educator the room is open while
 * the server is already refusing pupils. The dashboard showed exactly that: an
 * expired override read "Open" beside "Opens Mon 08:00" on the same card.
 *
 * `reason` is the same field `resolveAvailability` hands the enforcement guard,
 * so the badge and the door now agree by construction rather than by two call
 * sites being kept in step by hand.
 *
 * Lives outside `$lib/server` because both the dashboard row and the classroom
 * page render it; the type import is erased.
 */
export function classroomStateLabel(availability: AvailabilityStatus): string {
  switch (availability.reason) {
    case "explicit-lock":
      return m.educator_state_locked();
    case "explicit-open":
      return m.educator_state_open();
    case "scheduled":
      return m.educator_state_scheduled_open();
    case "outside-schedule":
      return m.educator_state_scheduled_closed();
  }
}
