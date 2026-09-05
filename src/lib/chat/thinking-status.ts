import * as m from "$lib/paraglide/messages";

/**
 * What to say while nothing has arrived yet (PRD §20).
 *
 * A reasoning model can spend forty seconds before its first word, and a single
 * frozen "Thinking…" for forty seconds reads as a stall rather than as work. So
 * the line moves through a short sequence and stops on the last one — it says
 * that time is passing, and never claims to know something it does not.
 *
 * Pure, and separate from the component, so the sequence can be tested without
 * a clock and the component holds only the tick.
 */
export const PLACEHOLDER_STATUSES = [
  m.chat_status_reading,
  m.chat_status_planning,
  m.chat_status_working,
  m.chat_status_writing,
] as const;

/** How long each line holds before the next one. */
export const PLACEHOLDER_INTERVAL_MS = 4_000;

/**
 * Which line to show after `elapsedMs`, clamped to the last one.
 *
 * Clamped rather than cycling: a sequence that loops back to "Reading your
 * message…" after sixteen seconds tells the pupil the model started over.
 */
export function placeholderIndex(
  elapsedMs: number,
  intervalMs = PLACEHOLDER_INTERVAL_MS,
  count = PLACEHOLDER_STATUSES.length,
): number {
  if (count <= 0) return 0;
  const step = Math.floor(Math.max(0, elapsedMs) / Math.max(1, intervalMs));
  return Math.min(step, count - 1);
}
