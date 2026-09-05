/**
 * Moving within a roving-`tabindex` group (PRD §20).
 *
 * A radio group and a tab list are one tab stop each, and the arrows are how you
 * move inside them. That is not a nicety: with `tabindex="-1"` on everything
 * that is not chosen, a group without arrow handling has positions no keyboard
 * can reach at all.
 *
 * Four controls keep this contract — the workspace switcher, the theme control,
 * the build pane's tabs and its file tree — so the arithmetic lives here once
 * rather than four times, and none of them can drift from the others.
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
 *
 * `orientation` says which arrows belong to the control. A radio group answers
 * to both pairs whichever way it is laid out, which is the pattern's own rule;
 * a horizontal tab list answers to Left and Right only, and leaves Up and Down
 * to the page they would otherwise scroll; a file tree is the mirror of that,
 * answering to Up and Down and leaving the horizontal pair to the editor beside
 * it.
 */
export function rovingTarget<T extends string>(
  event: KeyboardEvent,
  options: {
    values: readonly T[];
    current: T;
    attribute: string;
    orientation?: "inline" | "block" | "both";
  },
): T | null {
  const { values, current, attribute, orientation = "both" } = options;
  const blockAxis = orientation !== "inline";
  const inlineAxis = orientation !== "block";

  const step =
    (inlineAxis && event.key === "ArrowRight") || (blockAxis && event.key === "ArrowDown")
      ? 1
      : (inlineAxis && event.key === "ArrowLeft") || (blockAxis && event.key === "ArrowUp")
        ? -1
        : 0;
  if (step === 0) return null;

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
