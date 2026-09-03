<script lang="ts">
import { rovingTarget } from "$lib/a11y/roving";
import * as m from "$lib/paraglide/messages";
import type { WorkspaceStage } from "$lib/state/artifacts.svelte";
import type { SplitAxis } from "$lib/workspace/axis";
import WorkspaceGlyph from "./WorkspaceGlyph.svelte";

/**
 * The one control that decides what is on screen (PRD §13, §20).
 *
 * This replaces four separate controls — *Build*, *Split view*, *Fullscreen* and
 * *Close* — which between them described three states through four two-way
 * toggles, so a pupil had to work out the state machine to get from a fullscreen
 * preview back to their conversation. Three positions, one of them always
 * filled: where you are is where the mark is.
 *
 * A radio group rather than three buttons, because exactly one is true at a
 * time and that is what a radio group means to a screen reader. Roving
 * `tabindex` with arrow keys is the pattern's own keyboard contract: one tab
 * stop for the group, arrows to move within it.
 */
interface Props {
  stage: WorkspaceStage;
  axis: SplitAxis;
  /** Something was built that the pupil has not looked at yet (§13). */
  unseen?: boolean;
  /** How many artifacts this conversation holds, for the build position's count. */
  count?: number;
  onstage: (stage: WorkspaceStage) => void;
}

let { stage, axis, unseen = false, count = 0, onstage }: Props = $props();

const STAGES: readonly WorkspaceStage[] = ["chat", "both", "build"];

const labels: Record<WorkspaceStage, string> = $derived({
  chat: m.workspace_stage_chat(),
  both: m.workspace_stage_both(),
  build: m.workspace_stage_build(),
});

let group = $state<HTMLDivElement | null>(null);

/**
 * Arrow keys move the selection, which is what a radio group does.
 *
 * The move is applied immediately rather than only on Enter: with three
 * positions and a live layout behind them, "arrow to it and it happens" is both
 * the pattern's default and the thing a pupil expects.
 *
 * It counts from the focused radio rather than from `stage`, because `stage` is
 * not only the pupil's to move: `replace` reveals what the model just wrote, and
 * an arrow counting from the new stage would jump from a focused *Chat* to
 * *Build*, straight over the *Both* it had just been moved to.
 */
function onkeydown(event: KeyboardEvent): void {
  const next = rovingTarget(event, { values: STAGES, current: stage, attribute: "data-stage" });
  if (!next) return;

  event.preventDefault();
  onstage(next);

  // The moved-to radio takes focus, so the next arrow press continues from it.
  queueMicrotask(() => {
    group?.querySelector<HTMLElement>(`[data-stage="${next}"]`)?.focus();
  });
}
</script>

<div
  bind:this={group}
  role="radiogroup"
  aria-label={m.workspace_stage_label()}
  data-build-count={count}
  tabindex="-1"
  {onkeydown}
  class="relative flex shrink-0 items-center gap-0.5 rounded-lg border border-border bg-card p-0.5"
>
  {#each STAGES as candidate (candidate)}
    {@const active = stage === candidate}
    <button
      type="button"
      role="radio"
      data-stage={candidate}
      aria-label={labels[candidate]}
      aria-checked={active}
      tabindex={active ? 0 : -1}
      onclick={() => onstage(candidate)}
      class={[
        "flex h-9 min-w-11 items-center justify-center gap-1.5 rounded-md px-2 text-xs font-medium",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-card",
        "motion-safe:transition-colors",
        active
          ? "bg-primary/10 text-primary"
          : "text-muted-foreground hover:bg-secondary hover:text-foreground",
      ]}
    >
      <WorkspaceGlyph stage={candidate} {axis} />
      <span aria-hidden="true" class="hidden md:inline">{labels[candidate]}</span>
      {#if candidate === "build" && count > 0}
        <span
          aria-hidden="true"
          class="hidden font-mono text-[0.6875rem] tabular-nums opacity-70 md:inline"
        >
          {count}
        </span>
      {/if}
    </button>
  {/each}

  {#if unseen}
    <!-- Something was built while the pupil was reading (§13). -->
    <span
      aria-hidden="true"
      class="pointer-events-none absolute -right-1 -top-1 size-2.5 rounded-full bg-primary ring-2 ring-background"
    ></span>
  {/if}
</div>

<!--
  The same news, for a pupil who cannot see the dot.

  In the document from the first render, with only its text changing: a live
  region that appears and fills in the same update is not announced, which is
  what the dot's own hidden label used to be. Outside the group, because a
  radiogroup's children are its radios.
-->
<span role="status" class="sr-only">{unseen ? m.artifact_build_unseen() : ""}</span>
