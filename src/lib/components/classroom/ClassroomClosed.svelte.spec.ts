import { describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-svelte";
import * as m from "$lib/paraglide/messages";
import type { ClassroomStatus } from "$lib/server/classroom/status";
import ClassroomClosed from "./ClassroomClosed.svelte";

/**
 * The closed-classroom screen (plan 2.4, PRD §8, §22).
 *
 * "Students see a plain, friendly status screen with the next scheduled opening
 * — never a raw authorisation error, never any infrastructure detail."
 *
 * So the assertions are about the sentence a pupil reads and the instant it
 * names — including that the instant is rendered in the *classroom's* timezone,
 * because a school Chromebook set to the wrong zone would otherwise name the
 * wrong lesson.
 */

const ALLOWANCE: ClassroomStatus["allowance"] = {
  usedTokens: 0,
  limitTokens: 250_000,
  remainingTokens: 250_000,
  exhausted: false,
  classroomExhausted: false,
  costUsd: null,
  costDkk: null,
};

function statusOf(overrides: Partial<ClassroomStatus> = {}): ClassroomStatus {
  return {
    open: false,
    timezone: "Europe/Copenhagen",
    reason: "outside-schedule",
    nextOpeningAt: null,
    opensUntil: null,
    allowance: ALLOWANCE,
    ...overrides,
  };
}

describe("ClassroomClosed", () => {
  it("says a lesson is not running, without an authorisation error", async () => {
    render(ClassroomClosed, { status: statusOf() });

    await expect.element(page.getByText(m.classroom_closed_outside())).toBeInTheDocument();
    await expect.element(page.getByText(m.classroom_closed_title())).toBeInTheDocument();
  });

  it("says the teacher locked the room when that is why", async () => {
    render(ClassroomClosed, { status: statusOf({ reason: "explicit-lock" }) });

    await expect.element(page.getByText(m.classroom_closed_locked())).toBeInTheDocument();
  });

  it("names the next opening in the classroom's timezone, not the device's", async () => {
    render(ClassroomClosed, {
      status: statusOf({
        // Monday 5 January 2026, 08:00 UTC — 09:00 in Copenhagen.
        nextOpeningAt: "2026-01-05T08:00:00.000Z",
        timezone: "Europe/Copenhagen",
      }),
    });

    await expect.element(page.getByText(m.classroom_next_opening_label())).toBeInTheDocument();
    // 09 in Copenhagen; the raw UTC hour would read 08.
    await expect.element(page.getByText(/09/)).toBeInTheDocument();
  });

  it("renders the same instant differently for a classroom in another zone", async () => {
    render(ClassroomClosed, {
      status: statusOf({
        nextOpeningAt: "2026-01-05T08:00:00.000Z",
        timezone: "Asia/Tokyo",
      }),
    });

    // 17:00 in Tokyo for the same instant.
    await expect.element(page.getByText(/17/)).toBeInTheDocument();
  });

  it("promises nothing when there is no scheduled opening to promise", async () => {
    render(ClassroomClosed, { status: statusOf({ reason: "explicit-lock" }) });

    await expect.element(page.getByText(m.classroom_no_next_opening())).toBeInTheDocument();
    await expect.element(page.getByText(m.classroom_next_opening_label())).not.toBeInTheDocument();
  });
});
