import { describe, expect, it } from "vitest";
import type { AvailabilityStatus } from "$lib/server/classroom/schedule";
import { classroomStateLabel } from "./state-label";

/**
 * The panel's state badge (PRD §8, §17, §22).
 *
 * Runs under the `server` Vitest project rather than `bun test` because the
 * label calls Paraglide, which is a Vite virtual module.
 *
 * The case that matters is the last one: before this, both the dashboard row and
 * the classroom page derived their label from the stored `state` column, so a
 * lapsed "Open now" read "Open" while the enforcement guard was already turning
 * pupils away — and the same card simultaneously announced the next opening.
 */

const status = (reason: AvailabilityStatus["reason"], open: boolean): AvailabilityStatus => ({
  open,
  reason,
  nextOpeningAt: null,
  opensUntil: null,
});

describe("classroomStateLabel (§8, §17)", () => {
  it("names an explicit lock", () => {
    expect(classroomStateLabel(status("explicit-lock", false))).toBe("Locked");
  });

  it("names a standing open-now override", () => {
    expect(classroomStateLabel(status("explicit-open", true))).toBe("Open");
  });

  it("distinguishes a schedule that is open from one that is not", () => {
    expect(classroomStateLabel(status("scheduled", true))).toBe("Open — following the schedule");
    expect(classroomStateLabel(status("outside-schedule", false))).toBe(
      "Closed — outside the schedule",
    );
  });

  it("reads a lapsed override as closed, not as open", () => {
    // What `resolveAvailability` returns for `state='open'` with a past
    // `stateUntil`: the override is gone and the schedule has the room shut.
    expect(classroomStateLabel(status("outside-schedule", false))).not.toBe("Open");
  });
});
