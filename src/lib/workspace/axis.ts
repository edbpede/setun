/**
 * Which way the workspace splits (PRD §20).
 *
 * The two panes are the same two panes at every width; only the axis they
 * divide along changes. Side by side needs a second readable column, and the
 * target device is 1366 pixels wide — so `64rem` is the line, and everything
 * below it stacks the build surface under the conversation instead.
 *
 * Named for the CSS logical axes rather than "horizontal"/"vertical", because
 * "the inline axis" says which way the *divider moves* without anyone having to
 * work out whether the divider or the split was being described.
 */
export type SplitAxis = "inline" | "block";

/** Wide enough for two columns that are both worth reading. */
export const INLINE_SPLIT_QUERY = "(min-width: 64rem)";

/**
 * Watch the split axis, calling back on every change.
 *
 * Returns the teardown, so a caller inside an `$effect` can return it directly.
 * On the server there is no viewport, and `block` is the safe first paint: a
 * stacked layout at a wide viewport is briefly plain, where an inline split at a
 * narrow one is briefly unusable.
 */
export function watchSplitAxis(onChange: (axis: SplitAxis) => void): (() => void) | undefined {
  if (typeof window === "undefined" || !window.matchMedia) return;

  const query = window.matchMedia(INLINE_SPLIT_QUERY);
  const read = () => onChange(query.matches ? "inline" : "block");

  read();
  query.addEventListener("change", read);
  return () => query.removeEventListener("change", read);
}
