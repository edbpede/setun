import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import type { Classroom, TemporaryWindow, WeeklyWindow } from "../db/schema";

/**
 * Availability resolution (PRD §8).
 *
 * "Every classroom has an explicit open or locked state that overrides all
 * scheduling. On top of that sits a recurring weekly schedule expressed in the
 * classroom's IANA timezone… correct across daylight-saving transitions, plus
 * one-off windows."
 *
 * Every conversion from a local wall-clock time to an instant goes through
 * `date-fns-tz`. There is no offset arithmetic here and there must never be
 * (§5) — a recurring schedule is exactly where that temptation appears, because
 * "Monday 09:00" is a local time whose UTC instant moves twice a year.
 *
 * Two traps this module is written around, both of which produce code that
 * passes every test run in one timezone and fails in another:
 *
 * - Adding milliseconds to a "zoned" `Date` to reach a wall-clock time. On a
 *   spring-forward day, midnight plus nine hours is 10:00 local, not 09:00.
 *   Wall-clock times are therefore built as strings and converted once.
 * - Iterating days with local-calendar arithmetic. Calendar days are stepped as
 *   UTC midnights instead, which have no DST and are exactly 24 hours apart.
 */

const MINUTES_PER_DAY = 24 * 60;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** How far ahead `nextOpeningAt` looks. Beyond a fortnight, "next" tells a pupil nothing useful. */
const LOOKAHEAD_DAYS = 14;

/** The subset of classroom settings availability depends on. */
export type AvailabilitySettings = Pick<
  Classroom,
  "timezone" | "state" | "stateUntil" | "stateChangedAt" | "weeklySchedule" | "temporaryWindows"
>;

export interface AvailabilityStatus {
  readonly open: boolean;
  /**
   * Why it is open or closed. The closed screen says "next lesson starts…",
   * never "authorisation failed" (§8).
   */
  readonly reason: "explicit-open" | "explicit-lock" | "scheduled" | "outside-schedule";
  /** When the classroom next opens, or null when nothing is scheduled ahead (§8). */
  readonly nextOpeningAt: Date | null;
  /** When the current open period ends; null when it is open indefinitely. */
  readonly opensUntil: Date | null;
}

/** An absolute window, resolved from either a weekly or a one-off definition. */
interface ResolvedWindow {
  readonly start: Date;
  readonly end: Date;
}

function isValidWeeklyWindow(window: WeeklyWindow): boolean {
  return (
    Number.isInteger(window.weekday) &&
    window.weekday >= 0 &&
    window.weekday <= 6 &&
    Number.isFinite(window.startMinute) &&
    Number.isFinite(window.endMinute) &&
    window.startMinute >= 0 &&
    window.endMinute > window.startMinute &&
    window.endMinute <= MINUTES_PER_DAY
  );
}

/** A calendar date, stepped as UTC midnight so day arithmetic is exact. */
function calendarCursorFor(instant: Date, timezone: string): number {
  const [year, month, day] = formatInTimeZone(instant, timezone, "yyyy-MM-dd")
    .split("-")
    .map(Number);
  return Date.UTC(year, month - 1, day);
}

const pad = (value: number) => String(value).padStart(2, "0");

/**
 * The instant at which `minutes` past local midnight occurs on a calendar date.
 *
 * The wall-clock time is composed as a string and handed to `date-fns-tz` once,
 * so the conversion is the library's job in its entirety. Minutes may reach
 * 1440 (a window ending at local midnight), which rolls to the next date rather
 * than producing an invalid "24:00".
 */
function instantAt(cursorUtcMs: number, minutes: number, timezone: string): Date {
  const dayOffset = Math.floor(minutes / MINUTES_PER_DAY);
  const withinDay = minutes % MINUTES_PER_DAY;
  const date = new Date(cursorUtcMs + dayOffset * MS_PER_DAY);

  const stamp =
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}` +
    `T${pad(Math.floor(withinDay / 60))}:${pad(withinDay % 60)}:00`;

  return fromZonedTime(stamp, timezone);
}

function temporaryWindowOf(window: TemporaryWindow): ResolvedWindow | null {
  if (!Number.isFinite(window.startsAt) || !Number.isFinite(window.endsAt)) return null;
  if (window.endsAt <= window.startsAt) return null;
  return { start: new Date(window.startsAt), end: new Date(window.endsAt) };
}

/**
 * Every window overlapping roughly `[from - 1 day, from + days]`.
 *
 * Weekly windows are materialised one calendar day at a time — the only way a
 * recurring local time becomes an instant without assuming a fixed day length,
 * which DST days do not have.
 */
function windowsWithin(
  settings: AvailabilitySettings,
  from: Date,
  days: number,
): readonly ResolvedWindow[] {
  const windows: ResolvedWindow[] = [];
  const weekly = settings.weeklySchedule.filter(isValidWeeklyWindow);

  if (weekly.length > 0) {
    // Start a day early: a window that began yesterday evening and runs past
    // local midnight still covers `from`.
    const first = calendarCursorFor(from, settings.timezone) - MS_PER_DAY;

    for (let offset = 0; offset <= days + 1; offset++) {
      const cursor = first + offset * MS_PER_DAY;
      const weekday = new Date(cursor).getUTCDay();

      for (const window of weekly) {
        if (window.weekday !== weekday) continue;
        windows.push({
          start: instantAt(cursor, window.startMinute, settings.timezone),
          end: instantAt(cursor, window.endMinute, settings.timezone),
        });
      }
    }
  }

  for (const window of settings.temporaryWindows) {
    const resolved = temporaryWindowOf(window);
    if (resolved) windows.push(resolved);
  }

  return windows.sort((a, b) => a.start.getTime() - b.start.getTime());
}

function covering(settings: AvailabilitySettings, at: Date): readonly ResolvedWindow[] {
  return windowsWithin(settings, at, 1).filter(
    (window) => window.start.getTime() <= at.getTime() && at.getTime() < window.end.getTime(),
  );
}

/** True when the schedule alone would have the classroom open at `at`. */
export function isScheduledOpenAt(settings: AvailabilitySettings, at: Date): boolean {
  return covering(settings, at).length > 0;
}

/**
 * The end of the scheduled window covering `at`, or null when none does.
 *
 * This is also what "Open now, until the end of the current window" resolves
 * to (§8). Overlapping windows extend the lesson rather than truncating it.
 */
export function currentWindowEnd(settings: AvailabilitySettings, at: Date): Date | null {
  const windows = covering(settings, at);
  if (windows.length === 0) return null;

  return new Date(Math.max(...windows.map((window) => window.end.getTime())));
}

/** The next instant the schedule opens at or after `at`, within the lookahead. */
function nextScheduledOpening(settings: AvailabilitySettings, at: Date): Date | null {
  const upcoming = windowsWithin(settings, at, LOOKAHEAD_DAYS).find(
    (window) => window.end.getTime() > at.getTime(),
  );

  if (!upcoming) return null;
  // A window already under way opens now.
  return upcoming.start.getTime() <= at.getTime() ? at : upcoming.start;
}

/**
 * Resolve availability: explicit state first, then the schedule (§8).
 *
 * An "Open now" override carrying a duration lapses back to the schedule once
 * `stateUntil` passes — without which the schedule would be write-only after the
 * first manual open.
 */
export function resolveAvailability(
  settings: AvailabilitySettings,
  now: Date = new Date(),
): AvailabilityStatus {
  const overrideActive =
    settings.state !== "scheduled" &&
    (settings.stateUntil === null || settings.stateUntil.getTime() > now.getTime());

  if (overrideActive && settings.state === "locked") {
    return {
      open: false,
      reason: "explicit-lock",
      // A lock stands until the educator lifts it. Promising the next scheduled
      // opening would promise something the educator has not agreed to.
      nextOpeningAt: settings.stateUntil,
      opensUntil: null,
    };
  }

  if (overrideActive && settings.state === "open") {
    return {
      open: true,
      reason: "explicit-open",
      nextOpeningAt: null,
      opensUntil: settings.stateUntil,
    };
  }

  if (isScheduledOpenAt(settings, now)) {
    return {
      open: true,
      reason: "scheduled",
      nextOpeningAt: null,
      opensUntil: currentWindowEnd(settings, now),
    };
  }

  return {
    open: false,
    reason: "outside-schedule",
    nextOpeningAt: nextScheduledOpening(settings, now),
    opensUntil: null,
  };
}

/**
 * The instant the classroom most recently stopped being open, or null when it
 * has not closed within the lookback.
 *
 * The per-lesson session policy is defined against this: "sessions end when the
 * classroom closes" (§7). A session created after the last close survives; one
 * created before it does not.
 */
export function previousCloseAt(
  settings: AvailabilitySettings,
  now: Date = new Date(),
): Date | null {
  // An explicit lock closed the classroom at the moment it was applied.
  if (settings.state === "locked" && settings.stateChangedAt) return settings.stateChangedAt;

  const ended = windowsWithin(
    settings,
    new Date(now.getTime() - LOOKAHEAD_DAYS * MS_PER_DAY),
    LOOKAHEAD_DAYS,
  )
    .filter((window) => window.end.getTime() <= now.getTime())
    .sort((a, b) => b.end.getTime() - a.end.getTime())[0];

  return ended?.end ?? null;
}

/**
 * The durations the educator's "Open now" offers (PRD §8).
 *
 * "Open now, with duration options including until the end of the current
 * scheduled window."
 */
export const OPEN_DURATIONS = ["30", "60", "120", "window", "indefinite"] as const;
export type OpenDuration = (typeof OPEN_DURATIONS)[number];

/**
 * When an "Open now" override should lapse, or null for one that stands until
 * the educator lifts it.
 *
 * `window` outside any scheduled window has no end to run to, so it opens
 * indefinitely rather than closing again immediately — an educator who chose it
 * meant "for this lesson", and refusing them a lesson because the schedule is
 * empty would be the wrong reading.
 */
export function resolveOpenUntil(
  settings: AvailabilitySettings,
  duration: OpenDuration,
  now: Date = new Date(),
): Date | null {
  if (duration === "indefinite") return null;
  if (duration === "window") return currentWindowEnd(settings, now);

  return new Date(now.getTime() + Number(duration) * 60 * 1000);
}
