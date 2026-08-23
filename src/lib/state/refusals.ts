import * as m from "$lib/paraglide/messages";
import type { EnforcementRefusal } from "$lib/server/classroom/enforcement";

/**
 * Refusal codes to sentences a pupil can read (PRD §8, §10, §21).
 *
 * The server sends a code, never a sentence: "friendly status… never a raw
 * authorisation error, never any infrastructure detail" (§8), and a server
 * string rendered verbatim is exactly how infrastructure detail escapes.
 *
 * Keyed by the server's union so a refusal added there without a message here
 * fails `svelte-check` rather than reaching a classroom as a blank line.
 *
 * The type import is erased at compile time — no server code enters the bundle.
 */
const MESSAGES: Record<EnforcementRefusal, () => string> = {
  "classroom-locked": m.chat_refusal_classroom_locked,
  "outside-schedule": m.chat_refusal_outside_schedule,
  "model-not-allowed": m.chat_refusal_model_not_allowed,
  "student-allowance-exhausted": m.chat_refusal_student_allowance_exhausted,
  "classroom-cap-exhausted": m.chat_refusal_classroom_cap_exhausted,
  // A classroom that has been deleted under a live session. The pupil cannot act
  // on the cause, so they are told what they can do about it.
  "classroom-not-found": m.chat_refusal_unavailable,
};

/** The sentence for a refusal code, falling back for anything unrecognised. */
export function refusalMessage(code: unknown): string {
  if (typeof code === "string" && code in MESSAGES) {
    return MESSAGES[code as EnforcementRefusal]();
  }
  return m.chat_refusal_unavailable();
}
