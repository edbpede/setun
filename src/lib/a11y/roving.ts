/**
 * Moving within a roving-`tabindex` group (PRD §20).
 *
 * A radio group and a tab list are one tab stop each, and the arrows are how you
 * move inside them. That is not a nicety: with `tabindex="-1"` on everything
 * that is not chosen, a group without arrow handling has positions no keyboard
 * can reach at all.
 *
 * Three controls keep this contract — the workspace switcher, the theme
 * control, and the build pane's tabs — so the arithmetic lives here once rather
 * than three times, and the two that were missing it cannot drift from the one
 * that had it.
 */

/**
 * Where an arrow press should land, or null for a key that is not an arrow.
 *
 * The move starts from the element the event came from rather than from the
 * group's current value. The value can be moved by something that is not the
 * keyboard — a model write turning the workspace to what it just built — while
 * the focus stays where the pupil left it, and an arrow that counted from the
 * new value would then skip straight past the position that was just selected.
 *
 * `attribute` names the data attribute each control carries its own value in.
 */
export function rovingTarget<T extends string>(
  event: KeyboardEvent,
  options: { values: readonly T[]; current: T; attribute: string },
): T | null {
  const step =
    event.key === "ArrowRight" || event.key === "ArrowDown"
      ? 1
      : event.key === "ArrowLeft" || event.key === "ArrowUp"
        ? -1
        : 0;
  if (step === 0) return null;

  const { values, current, attribute } = options;
  if (values.length === 0) return null;

  const focused =
    event.target instanceof Element
      ? (event.target.closest(`[${attribute}]`)?.getAttribute(attribute) ?? null)
      : null;
  const from = values.find((value) => value === focused) ?? current;

  // A `current` the group does not offer counts as the first position, so the
  // very next press still lands somewhere reachable.
  const at = Math.max(0, values.indexOf(from));
  return values[(at + step + values.length) % values.length];
}
