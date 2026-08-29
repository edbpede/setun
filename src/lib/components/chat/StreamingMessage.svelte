<script lang="ts">
import { turnNoticeText } from "$lib/chat/turn-notices";
import * as m from "$lib/paraglide/messages";
import type { StreamingTurn } from "$lib/state/streaming-turn.svelte";
import MessageParts from "./MessageParts.svelte";

/**
 * The turn currently streaming (PRD §10, §11, §20).
 *
 * Prose stays plain preformatted text until the turn settles and the message
 * joins the list: re-parsing and re-highlighting a growing message on every
 * delta is the work that drops frames on the target hardware (§20).
 *
 * The permission prompt and the elicitation form are rendered by the page rather
 * than here, because they are the turn's only interactive parts and the page
 * owns the endpoint they answer to.
 */
interface Props {
  turn: StreamingTurn;
}

let { turn }: Props = $props();

let noticeText = $derived(turn.notice ? turnNoticeText(turn.notice) : null);
</script>

{#if turn.streaming || !turn.isEmpty || noticeText}
  <article
    class="flex flex-col items-start gap-1"
    data-role="assistant"
    data-streaming={turn.streaming}
  >
    <div
      class="max-w-[85%] rounded-lg border border-border bg-card px-3 py-2 text-sm leading-relaxed text-card-foreground"
    >
      {#if turn.isEmpty && turn.streaming}
        <p class="text-muted-foreground" aria-live="polite">{m.chat_thinking()}</p>
      {:else}
        <MessageParts parts={turn.parts} streaming />
      {/if}

      {#if noticeText}
        <p class="mt-2 text-xs text-muted-foreground">{noticeText}</p>
      {/if}
    </div>
  </article>
{/if}
