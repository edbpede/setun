<script lang="ts">
import * as m from "$lib/paraglide/messages";
import type { StreamingTurn } from "$lib/state/streaming-turn.svelte";

/**
 * The turn currently streaming (PRD §10, §20).
 *
 * Deliberately plain preformatted text rather than markdown: re-parsing and
 * re-highlighting a growing message on every delta is the work that drops frames
 * on the target hardware. It becomes a `MarkdownMessage` once the turn settles
 * and the message joins the list (§20).
 */
interface Props {
  turn: StreamingTurn;
}

let { turn }: Props = $props();

let noticeText = $derived(
  turn.notice === "aborted"
    ? m.chat_notice_aborted()
    : turn.notice === "interrupted"
      ? m.chat_notice_interrupted()
      : turn.notice === "error"
        ? m.chat_notice_error()
        : null,
);
</script>

{#if turn.streaming || !turn.isEmpty || noticeText}
  <article class="flex flex-col items-start gap-1" data-role="assistant" data-streaming={turn.streaming}>
    <div
      class="max-w-[85%] rounded-lg border border-border bg-card px-3 py-2 text-sm leading-relaxed text-card-foreground"
    >
      {#if turn.isEmpty && turn.streaming}
        <p class="text-muted-foreground" aria-live="polite">{m.chat_thinking()}</p>
      {:else}
        <p class="whitespace-pre-wrap break-words">{turn.text}</p>
      {/if}

      {#if noticeText}
        <p class="mt-2 text-xs text-muted-foreground">{noticeText}</p>
      {/if}
    </div>
  </article>
{/if}
