<script lang="ts">
import * as m from "$lib/paraglide/messages";
import type { PendingContinue } from "$lib/state/streaming-turn.svelte";

/**
 * "Shall I keep going?" at a checkpoint (PRD §10, §20).
 *
 * The same shell as `PermissionPrompt`, because it is the same kind of moment:
 * the loop has stopped at a clean boundary, everything it produced is durable,
 * and it is asking rather than deciding for the pupil. A per-turn cap used to
 * end the turn here without asking, which is how a long answer came to stop
 * mid-sentence.
 *
 * The sentence says *why* it paused, in the pupil's own terms — steps taken,
 * seconds worked, tokens spent — so "keep going" is an informed answer rather
 * than a reflex.
 */
interface Props {
  prompt: PendingContinue;
  onrespond: (proceed: boolean) => void;
}

let { prompt, onrespond }: Props = $props();

const reason = $derived.by(() => {
  switch (prompt.cause) {
    case "steps":
      return m.chat_continue_cause_steps({ steps: prompt.steps });
    case "wall-clock":
      return m.chat_continue_cause_wall_clock({ seconds: Math.round(prompt.elapsedMs / 1000) });
    case "tokens":
      return m.chat_continue_cause_tokens({ tokens: prompt.tokens });
    default:
      return m.chat_continue_cause_daily_warning();
  }
});
</script>

<section
  class="flex max-w-[85%] flex-col gap-2 rounded-lg border border-primary/30 bg-card px-3 py-2.5"
  aria-live="polite"
>
  <div class="flex flex-col gap-0.5">
    <p class="text-sm font-medium text-foreground">{m.chat_continue_title()}</p>
    <p class="text-sm text-muted-foreground">{reason}</p>
    <p class="text-xs text-muted-foreground">
      {m.allowance_used({ used: prompt.usedTokens, limit: prompt.limitTokens })}
    </p>
  </div>

  <div class="flex gap-2">
    <button
      type="button"
      onclick={() => onrespond(true)}
      class="h-11 flex-1 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90"
    >
      {m.chat_continue_yes()}
    </button>
    <button
      type="button"
      onclick={() => onrespond(false)}
      class="h-11 flex-1 rounded-md border border-input px-4 text-sm font-medium text-foreground hover:bg-secondary"
    >
      {m.chat_continue_stop()}
    </button>
  </div>
</section>
