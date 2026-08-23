import { describe, expect, it } from "bun:test";
import type { AvailabilitySettings } from "./schedule";
import {
  currentWindowEnd,
  isScheduledOpenAt,
  previousCloseAt,
  resolveAvailability,
  resolveOpenUntil,
} from "./schedule";

/**
 * Schedule resolution, including daylight-saving boundaries in both directions
 * (plan 2.3, PRD §8, §22).
 *
 * "`bun test` covers… schedule and timezone resolution including daylight-saving
 * boundaries" (§22).
 *
 * Every instant below is written as a UTC literal and every expectation is about
 * what a Copenhagen wall clock reads at that instant. That is the whole point:
 * a lesson is defined in local time, and the assertions fail if anything in the
 * module assumes a fixed offset.
 *
 * Europe/Copenhagen in 2026: CET (UTC+1) until 02:00 local on Sunday 29 March,
 * then CEST (UTC+2) until 03:00 local on Sunday 25 October.
 */

const CLASSROOM: AvailabilitySettings = {
  timezone: "Europe/Copenhagen",
  state: "scheduled",
  stateUntil: null,
  stateChangedAt: null,
  weeklySchedule: [],
  temporaryWindows: [],
};

/** Monday 09:00–10:00 local — the ordinary lesson used across the DST cases. */
const MONDAY_MORNING = { weekday: 1, startMinute: 9 * 60, endMinute: 10 * 60 };

const withSchedule = (
  ...windows: AvailabilitySettings["weeklySchedule"]
): AvailabilitySettings => ({
  ...CLASSROOM,
  weeklySchedule: windows,
});

describe("isScheduledOpenAt — winter, CET (UTC+1)", () => {
  const settings = withSchedule(MONDAY_MORNING);

  // Monday 5 January 2026. 09:00 local is 08:00 UTC.
  it("is open at 09:00 local", () => {
    expect(isScheduledOpenAt(settings, new Date("2026-01-05T08:00:00Z"))).toBe(true);
  });

  it("is closed one minute before the window opens", () => {
    expect(isScheduledOpenAt(settings, new Date("2026-01-05T07:59:00Z"))).toBe(false);
  });

  it("is closed at the instant the window ends", () => {
    expect(isScheduledOpenAt(settings, new Date("2026-01-05T09:00:00Z"))).toBe(false);
  });

  it("is closed on another weekday at the same clock time", () => {
    expect(isScheduledOpenAt(settings, new Date("2026-01-06T08:00:00Z"))).toBe(false);
  });
});

describe("isScheduledOpenAt — summer, CEST (UTC+2)", () => {
  const settings = withSchedule(MONDAY_MORNING);

  /**
   * The regression this suite exists for: the same lesson, six months later, is
   * a different UTC instant. Code that stored an offset once would fail here.
   */
  // Monday 6 July 2026. 09:00 local is 07:00 UTC.
  it("is open at 09:00 local, which is now an hour earlier in UTC", () => {
    expect(isScheduledOpenAt(settings, new Date("2026-07-06T07:00:00Z"))).toBe(true);
  });

  it("is closed at the UTC instant that was open in winter", () => {
    // 08:00 UTC is 10:00 local in summer — the lesson has ended.
    expect(isScheduledOpenAt(settings, new Date("2026-07-06T08:00:00Z"))).toBe(false);
  });
});

describe("spring forward — 29 March 2026, 02:00 local becomes 03:00", () => {
  /**
   * A Sunday window spanning the skipped hour. 01:00 local is 00:00 UTC (CET);
   * 04:00 local is 02:00 UTC (CEST). Three hours on the wall clock, two hours of
   * elapsed time — which is exactly what a fixed-offset implementation gets
   * wrong.
   */
  const settings = withSchedule({ weekday: 0, startMinute: 60, endMinute: 4 * 60 });

  it("opens at 01:00 local", () => {
    expect(isScheduledOpenAt(settings, new Date("2026-03-29T00:00:00Z"))).toBe(true);
  });

  it("is still open across the transition instant", () => {
    // 01:00 UTC is 03:00 local — the clock has just jumped, the lesson continues.
    expect(isScheduledOpenAt(settings, new Date("2026-03-29T01:00:00Z"))).toBe(true);
  });

  it("closes at 04:00 local, two elapsed hours after it opened", () => {
    expect(isScheduledOpenAt(settings, new Date("2026-03-29T01:59:00Z"))).toBe(true);
    expect(isScheduledOpenAt(settings, new Date("2026-03-29T02:00:00Z"))).toBe(false);
  });

  it("reports the window ending at the correct instant", () => {
    const end = currentWindowEnd(settings, new Date("2026-03-29T00:30:00Z"));

    expect(end?.toISOString()).toBe("2026-03-29T02:00:00.000Z");
  });

  it("keeps a Monday lesson at 09:00 local on both sides of the transition", () => {
    const monday = withSchedule(MONDAY_MORNING);

    // The Monday before: CET, 09:00 local is 08:00 UTC.
    expect(isScheduledOpenAt(monday, new Date("2026-03-23T08:00:00Z"))).toBe(true);
    // The Monday after: CEST, 09:00 local is 07:00 UTC.
    expect(isScheduledOpenAt(monday, new Date("2026-03-30T07:00:00Z"))).toBe(true);
    expect(isScheduledOpenAt(monday, new Date("2026-03-30T08:00:00Z"))).toBe(false);
  });
});

describe("fall back — 25 October 2026, 03:00 local becomes 02:00", () => {
  /**
   * The repeated hour. 01:00 local is 23:00 UTC on the 24th (CEST); 04:00 local
   * is 03:00 UTC (CET). Three hours on the wall clock, four hours elapsed.
   */
  const settings = withSchedule({ weekday: 0, startMinute: 60, endMinute: 4 * 60 });

  it("opens at 01:00 local", () => {
    expect(isScheduledOpenAt(settings, new Date("2026-10-24T23:00:00Z"))).toBe(true);
  });

  it("stays open through the repeated hour", () => {
    // 00:30 UTC is 02:30 CEST; 01:30 UTC is 02:30 CET — the same wall clock twice.
    expect(isScheduledOpenAt(settings, new Date("2026-10-25T00:30:00Z"))).toBe(true);
    expect(isScheduledOpenAt(settings, new Date("2026-10-25T01:30:00Z"))).toBe(true);
  });

  it("closes at 04:00 local, four elapsed hours after it opened", () => {
    expect(isScheduledOpenAt(settings, new Date("2026-10-25T02:59:00Z"))).toBe(true);
    expect(isScheduledOpenAt(settings, new Date("2026-10-25T03:00:00Z"))).toBe(false);
  });

  it("keeps a Monday lesson at 09:00 local on both sides of the transition", () => {
    const monday = withSchedule(MONDAY_MORNING);

    // The Monday before: CEST, 09:00 local is 07:00 UTC.
    expect(isScheduledOpenAt(monday, new Date("2026-10-19T07:00:00Z"))).toBe(true);
    // The Monday after: CET, 09:00 local is 08:00 UTC.
    expect(isScheduledOpenAt(monday, new Date("2026-10-26T08:00:00Z"))).toBe(true);
    expect(isScheduledOpenAt(monday, new Date("2026-10-26T07:00:00Z"))).toBe(false);
  });
});

describe("windows ending at local midnight", () => {
  const settings = withSchedule({ weekday: 1, startMinute: 22 * 60, endMinute: 24 * 60 });

  it("runs to midnight without rolling over into an invalid time", () => {
    // Monday 5 January 2026, 23:30 local is 22:30 UTC.
    expect(isScheduledOpenAt(settings, new Date("2026-01-05T22:30:00Z"))).toBe(true);
    // 00:00 local on Tuesday is 23:00 UTC on Monday — closed.
    expect(isScheduledOpenAt(settings, new Date("2026-01-05T23:00:00Z"))).toBe(false);
  });
});

describe("other timezones", () => {
  it("resolves the same schedule differently per classroom timezone", () => {
    const copenhagen = withSchedule(MONDAY_MORNING);
    const reykjavik = { ...copenhagen, timezone: "Atlantic/Reykjavik" };

    const at = new Date("2026-01-05T09:00:00Z");

    // 09:00 UTC is 10:00 in Copenhagen (closed) and 09:00 in Reykjavik (open).
    expect(isScheduledOpenAt(copenhagen, at)).toBe(false);
    expect(isScheduledOpenAt(reykjavik, at)).toBe(true);
  });
});

describe("resolveAvailability — explicit state overrides the schedule", () => {
  const scheduled = withSchedule(MONDAY_MORNING);
  const duringLesson = new Date("2026-01-05T08:30:00Z");
  const outsideLesson = new Date("2026-01-05T12:00:00Z");

  it("locks immediately, even inside a scheduled window", () => {
    const status = resolveAvailability(
      { ...scheduled, state: "locked", stateChangedAt: duringLesson },
      duringLesson,
    );

    expect(status.open).toBe(false);
    expect(status.reason).toBe("explicit-lock");
  });

  it("opens on demand outside every scheduled window", () => {
    const status = resolveAvailability({ ...scheduled, state: "open" }, outsideLesson);

    expect(status.open).toBe(true);
    expect(status.reason).toBe("explicit-open");
    expect(status.opensUntil).toBeNull();
  });

  it("reports when a timed open-now override ends", () => {
    const until = new Date(outsideLesson.getTime() + 30 * 60 * 1000);
    const status = resolveAvailability(
      { ...scheduled, state: "open", stateUntil: until },
      outsideLesson,
    );

    expect(status.open).toBe(true);
    expect(status.opensUntil).toEqual(until);
  });

  it("lapses back to the schedule once the override expires", () => {
    const expired = new Date(outsideLesson.getTime() - 60 * 1000);
    const status = resolveAvailability(
      { ...scheduled, state: "open", stateUntil: expired },
      outsideLesson,
    );

    expect(status.open).toBe(false);
    expect(status.reason).toBe("outside-schedule");
  });

  it("follows the schedule when no override stands", () => {
    expect(resolveAvailability(scheduled, duringLesson).reason).toBe("scheduled");
    expect(resolveAvailability(scheduled, duringLesson).open).toBe(true);
    expect(resolveAvailability(scheduled, outsideLesson).open).toBe(false);
  });
});

describe("resolveAvailability — the closed screen's next opening (§8)", () => {
  it("names the next scheduled opening", () => {
    const settings = withSchedule(MONDAY_MORNING);
    const friday = new Date("2026-01-02T12:00:00Z");

    const status = resolveAvailability(settings, friday);

    expect(status.open).toBe(false);
    // Monday 5 January, 09:00 local (CET) is 08:00 UTC.
    expect(status.nextOpeningAt?.toISOString()).toBe("2026-01-05T08:00:00.000Z");
  });

  it("crosses a DST boundary when computing the next opening", () => {
    const settings = withSchedule(MONDAY_MORNING);
    // Saturday 28 March, the day before the clocks go forward.
    const beforeTransition = new Date("2026-03-28T12:00:00Z");

    const status = resolveAvailability(settings, beforeTransition);

    // Monday 30 March is CEST: 09:00 local is 07:00 UTC, not 08:00.
    expect(status.nextOpeningAt?.toISOString()).toBe("2026-03-30T07:00:00.000Z");
  });

  it("returns null when nothing is scheduled", () => {
    const status = resolveAvailability(CLASSROOM, new Date("2026-01-02T12:00:00Z"));

    expect(status.open).toBe(false);
    expect(status.nextOpeningAt).toBeNull();
  });

  it("does not promise an opening while an indefinite lock stands", () => {
    const settings = { ...withSchedule(MONDAY_MORNING), state: "locked" as const };

    expect(
      resolveAvailability(settings, new Date("2026-01-02T12:00:00Z")).nextOpeningAt,
    ).toBeNull();
  });
});

describe("temporary windows (§8)", () => {
  it("opens the classroom for a one-off homework window", () => {
    const start = new Date("2026-01-03T18:00:00Z");
    const end = new Date("2026-01-03T20:00:00Z");
    const settings: AvailabilitySettings = {
      ...CLASSROOM,
      temporaryWindows: [{ startsAt: start.getTime(), endsAt: end.getTime(), note: "lektier" }],
    };

    expect(isScheduledOpenAt(settings, new Date("2026-01-03T19:00:00Z"))).toBe(true);
    expect(isScheduledOpenAt(settings, new Date("2026-01-03T17:59:00Z"))).toBe(false);
    expect(isScheduledOpenAt(settings, end)).toBe(false);
  });

  it("ignores a window whose end does not follow its start", () => {
    const settings: AvailabilitySettings = {
      ...CLASSROOM,
      temporaryWindows: [{ startsAt: 2_000, endsAt: 1_000 }],
    };

    expect(isScheduledOpenAt(settings, new Date(1_500))).toBe(false);
  });
});

describe("malformed schedule entries", () => {
  it("are ignored rather than throwing", () => {
    const settings = withSchedule(
      { weekday: 9, startMinute: 0, endMinute: 60 },
      { weekday: 1, startMinute: 600, endMinute: 540 },
      { weekday: 1, startMinute: -60, endMinute: 60 },
      MONDAY_MORNING,
    );

    expect(isScheduledOpenAt(settings, new Date("2026-01-05T08:00:00Z"))).toBe(true);
    expect(isScheduledOpenAt(settings, new Date("2026-01-05T12:00:00Z"))).toBe(false);
  });
});

describe("previousCloseAt — the per-lesson session boundary (§7)", () => {
  it("is the instant an explicit lock was applied", () => {
    const lockedAt = new Date("2026-01-05T08:30:00Z");
    const settings = {
      ...withSchedule(MONDAY_MORNING),
      state: "locked" as const,
      stateChangedAt: lockedAt,
    };

    expect(previousCloseAt(settings, new Date("2026-01-05T09:00:00Z"))).toEqual(lockedAt);
  });

  it("is the end of the last scheduled window otherwise", () => {
    const settings = withSchedule(MONDAY_MORNING);

    // Tuesday: the last window ended Monday at 10:00 local (09:00 UTC).
    const closed = previousCloseAt(settings, new Date("2026-01-06T12:00:00Z"));

    expect(closed?.toISOString()).toBe("2026-01-05T09:00:00.000Z");
  });

  it("is null when the classroom has never been open", () => {
    expect(previousCloseAt(CLASSROOM, new Date("2026-01-06T12:00:00Z"))).toBeNull();
  });
});

describe("resolveOpenUntil — the Open now durations (plan 2.3, §8)", () => {
  const settings = withSchedule(MONDAY_MORNING);
  // Monday 5 January 2026, 09:15 Copenhagen (CET) is 08:15 UTC — inside the lesson.
  const insideLesson = new Date("2026-01-05T08:15:00Z");

  it("returns null for an open that stands until the educator locks it", () => {
    expect(resolveOpenUntil(settings, "indefinite", insideLesson)).toBeNull();
  });

  it("adds the chosen number of minutes", () => {
    const until = resolveOpenUntil(settings, "30", insideLesson);

    expect(until?.toISOString()).toBe("2026-01-05T08:45:00.000Z");
  });

  it("runs to the end of the current scheduled window", () => {
    const until = resolveOpenUntil(settings, "window", insideLesson);

    // 10:00 local on a CET day is 09:00 UTC.
    expect(until?.toISOString()).toBe("2026-01-05T09:00:00.000Z");
  });

  it("finds the right instant for the same window in summer, an hour off in UTC", () => {
    // Monday 6 July 2026, 09:15 Copenhagen (CEST) is 07:15 UTC.
    const until = resolveOpenUntil(settings, "window", new Date("2026-07-06T07:15:00Z"));

    expect(until?.toISOString()).toBe("2026-07-06T08:00:00.000Z");
  });

  it("opens indefinitely when 'until the lesson ends' is chosen outside every window", () => {
    // Chosen on a Tuesday, when no lesson is running: an educator who meant
    // "for this lesson" gets a lesson rather than a classroom that shuts at once.
    const until = resolveOpenUntil(settings, "window", new Date("2026-01-06T08:15:00Z"));

    expect(until).toBeNull();
  });
});
