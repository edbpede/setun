import type { ThinkingVisibility } from "$lib/server/db/schema";
import type { ThinkingPreference } from "$lib/state/thinking.svelte";

/**
 * The classroom's policy and the pupil's own switch, resolved to one answer
 * (PRD §20).
 *
 * Pure, and shared by everything that has to decide — the transcript, the
 * streaming message, the drawer footer — so a block cannot appear in one place
 * and not another. The type import is erased at compile time.
 *
 * `hidden` is belt and braces here: the server drops those events before they
 * reach a browser, so there is nothing to show. It is still checked, because a
 * message persisted while the policy said `student` is still on disk when the
 * educator changes their mind.
 */
export function effectiveThinking(
  policy: ThinkingVisibility,
  preference: ThinkingPreference,
): boolean {
  if (policy === "hidden") return false;
  if (policy === "shown") return true;
  return preference === "show";
}

/**
 * Whether the pupil's switch decides anything.
 *
 * A control that cannot change what happens is a promise the interface does not
 * keep, so where the classroom has decided, the switch is not offered at all.
 */
export function thinkingChoiceAvailable(policy: ThinkingVisibility): boolean {
  return policy === "student";
}
