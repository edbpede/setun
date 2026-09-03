<script lang="ts">
import SetunMark from "$lib/components/brand/SetunMark.svelte";
import * as m from "$lib/paraglide/messages";
import type { ComposerMode } from "$lib/state/composer.svelte";

/**
 * The first thing a pupil sees, and the last thing they saw before this: an
 * empty box (PRD §10, §13, §15, §20).
 *
 * "Ask your first question" is true and unhelpful — a class of twelve-year-olds
 * given a text field asks it what it is called. The three openers are the three
 * things this composer can actually do, in the order they cost: ask, build,
 * draw. The eyebrow above each says which, so the surface teaches its own shape
 * rather than describing it.
 *
 * The picture opener appears only where a generation-capable alias is
 * allowlisted, because an opener for something the classroom cannot do is worse
 * than no opener (§15).
 */
interface Props {
  /** Present only where a generation-capable alias is allowlisted (§15). */
  imageModeAvailable?: boolean;
  onpick: (starter: { text: string; mode: ComposerMode }) => void;
}

let { imageModeAvailable = false, onpick }: Props = $props();

const starters = $derived([
  { kind: m.chat_starter_kind_ask(), text: m.chat_starter_ask(), mode: "text" as const },
  { kind: m.chat_starter_kind_build(), text: m.chat_starter_build(), mode: "text" as const },
  ...(imageModeAvailable
    ? [{ kind: m.chat_starter_kind_draw(), text: m.chat_starter_draw(), mode: "image" as const }]
    : []),
]);
</script>

<div class="flex flex-col items-center gap-6 pt-10 pb-2 text-center sm:pt-16">
  <SetunMark size={40} class="text-primary" />

  <div class="flex flex-col gap-1.5">
    <h1 class="text-lg font-semibold tracking-tight text-foreground">{m.chat_empty_heading()}</h1>
    <p class="max-w-sm text-sm text-muted-foreground">{m.chat_empty_body()}</p>
  </div>

  <ul class="flex w-full max-w-md flex-col gap-2">
    {#each starters as starter (starter.kind)}
      <li>
        <button
          type="button"
          onclick={() => onpick({ text: starter.text, mode: starter.mode })}
          class="group/starter flex w-full flex-col items-start gap-0.5 rounded-lg border border-border bg-card px-3 py-2.5 text-left hover:border-primary/40 hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-safe:transition-colors"
        >
          <!-- The machine layer is always the mono face, labels included. -->
          <span
            class="font-mono text-[0.625rem] font-medium uppercase tracking-[0.14em] text-muted-foreground group-hover/starter:text-primary"
          >
            {starter.kind}
          </span>
          <span class="text-sm text-card-foreground">{starter.text}</span>
        </button>
      </li>
    {/each}
  </ul>
</div>
