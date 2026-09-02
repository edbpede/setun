<script lang="ts">
import type { BuildStatus } from "$lib/artifacts/types";
import * as m from "$lib/paraglide/messages";

/**
 * Build state as a trit (PRD §13, §20).
 *
 * Setun is named after the ternary computer, and build state is genuinely
 * three-valued: it ran, it did not run, or nobody has pressed Run. So it is
 * drawn as three slots with one filled — left for failed, centre for not run,
 * right for ran — rather than as a coloured dot whose meaning has to be learned
 * from a legend.
 *
 * A page that mounted and then threw is still three slots and still the right
 * one: it *ran*, and moving it to the left would say the opposite. It is drawn
 * hollow instead, which reads without colour, and carries the failed tone for
 * anyone who does see colour.
 *
 * The same glyph appears in the transcript card, the panel's status strip and
 * the History list, which is what makes it readable: a pupil sees it three times
 * in the same lesson and it means the same thing in all three.
 *
 * Colour carries no information the position does not, so it stays inside the
 * three tokens already in use — `destructive`, `muted-foreground`, `primary` —
 * and a pupil who cannot separate them still reads the position.
 */
interface Props {
  /** Null means nobody has run this revision, which is the middle slot. */
  status: BuildStatus | null;
  class?: string;
}

let { status, class: className = "" }: Props = $props();

const filled = $derived(status === "failed" ? 0 : status === "ok" || status === "threw" ? 2 : 1);
/** The filled slot drawn as a ring: it ran, and then it stopped. */
const hollow = $derived(status === "threw");
const tone = $derived(
  status === "failed" || status === "threw"
    ? "text-destructive"
    : status === "ok"
      ? "text-primary"
      : "text-muted-foreground",
);
const label = $derived(
  status === "failed"
    ? m.artifact_status_failed()
    : status === "threw"
      ? m.artifact_status_threw()
      : status === "ok"
        ? m.artifact_status_ran()
        : m.artifact_status_not_run(),
);
</script>

<svg
  viewBox="0 0 22 8"
  width="22"
  height="8"
  role="img"
  aria-label={label}
  class={["shrink-0", tone, className]}
  fill="none"
>
  {#each [0, 1, 2] as slot (slot)}
    <circle
      cx={4 + slot * 7}
      cy="4"
      r={slot === filled ? 3 : 2}
      fill={slot === filled && !hollow ? "currentColor" : "none"}
      stroke="currentColor"
      stroke-width={slot === filled && hollow ? "2" : "1"}
      opacity={slot === filled ? 1 : 0.35}
    />
  {/each}
</svg>
