<script lang="ts">
import * as m from "$lib/paraglide/messages";
import type { BudgetWarning } from "$lib/state/streaming-turn.svelte";

/**
 * "You have used most of today's allowance" (PRD §10, §20).
 *
 * Shown the moment the day passes 70 %, while the answer is still arriving — a
 * response in flight is never cut for this. So the pupil gets the figure and a
 * real choice: stop now and keep what is left, or say to carry on, which answers
 * the checkpoint before the loop reaches it and lets the answer run on
 * uninterrupted.
 *
 * Once the turn has finished the buttons go: there is nothing left to continue
 * or to stop, and the sentence is simply a fact about the pupil's day. It
 * survives the streaming message being replaced by the persisted one, because it
 * was never about that message.
 */
interface Props {
  warning: BudgetWarning;
  streaming: boolean;
  onkeepgoing: () => void;
  onstop: () => void;
}

let { warning, streaming, onkeepgoing, onstop }: Props = $props();

const percent = $derived(Math.round(warning.fraction * 100));
const showButtons = $derived(streaming && !warning.acknowledged);
</script>

<section
  class="flex max-w-[85%] flex-col gap-2 rounded-lg border border-primary/30 bg-card px-3 py-2.5"
  aria-live="polite"
>
  <div class="flex flex-col gap-0.5">
    <p class="text-sm font-medium text-foreground">
      {m.chat_budget_warning_title({ percent })}
    </p>
    <p class="text-xs text-muted-foreground">
      {m.allowance_used({ used: warning.usedTokens, limit: warning.limitTokens })}
    </p>
    {#if showButtons}
      <p class="text-sm text-muted-foreground">{m.chat_budget_warning_body()}</p>
    {/if}
  </div>

  {#if showButtons}
    <div class="flex gap-2">
      <button
        type="button"
        onclick={onkeepgoing}
        class="h-11 flex-1 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90"
      >
        {m.chat_budget_warning_keep_going()}
      </button>
      <button
        type="button"
        onclick={onstop}
        class="h-11 flex-1 rounded-md border border-input px-4 text-sm font-medium text-foreground hover:bg-secondary"
      >
        {m.chat_stop()}
      </button>
    </div>
  {/if}
</section>
