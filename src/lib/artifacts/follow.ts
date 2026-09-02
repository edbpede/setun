/**
 * Which artifact the panel should follow (PRD §13, §20).
 *
 * "A prominent Build entry point makes artifact work discoverable" — but a pupil
 * who asks for a quiz and gets one still has to find it. So when a model write
 * lands, the panel opens on it and follows the model's latest write while it
 * stays open.
 *
 * Only the model's writes. A revision the pupil made themselves is already on
 * their screen — the panel is where they made it — and following it would fight
 * the editor. Every version is retained either way, so nothing here loses work.
 *
 * A pure comparison over the two lists, so the rule is `bun test`-able rather
 * than reachable only through a rune module.
 */

export interface FollowCandidate {
  readonly id: string;
  readonly latest: {
    readonly id: string;
    readonly authoredBy: "model" | "student";
  };
}

/**
 * The artifact of the latest model-authored new or changed row, or null.
 *
 * Null on the first hydration — `previous` empty is a page that just loaded, not
 * a turn that just landed, and opening the panel over a reloaded conversation
 * would be an interface acting on nothing that happened.
 *
 * A tie (two artifacts written in one message) resolves to the first in `next`,
 * which the server orders by recording order: the first block the model wrote is
 * the one the sentence around it was about.
 */
export function followModelWrite(
  previous: readonly FollowCandidate[],
  next: readonly FollowCandidate[],
): string | null {
  if (previous.length === 0) return null;

  const before = new Map(previous.map((item) => [item.id, item.latest.id]));

  for (const item of next) {
    if (item.latest.authoredBy !== "model") continue;

    const held = before.get(item.id);
    // New row, or the same row with a revision it did not have before.
    if (held === undefined || held !== item.latest.id) return item.id;
  }

  return null;
}
