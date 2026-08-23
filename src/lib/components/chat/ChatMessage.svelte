<script lang="ts">
import * as m from "$lib/paraglide/messages";
import { type ChatMessage, textOf } from "$lib/state/conversation.svelte";
import MessageParts from "./MessageParts.svelte";

/**
 * One settled message in the conversation (PRD §10, §20).
 *
 * Off-screen messages use content-visibility so a long conversation does not
 * cost layout on every frame (§20).
 */
interface Props {
  message: ChatMessage;
  /** Editing a prompt branches the tree as a sibling (§10). */
  onedit?: (message: { id: string; text: string }) => void;
  onregenerate?: (message: ChatMessage) => void;
}

let { message, onedit, onregenerate }: Props = $props();

let isUser = $derived(message.role === "user");
</script>

<article
  class={[
    "group/message contain-message flex flex-col gap-1",
    isUser ? "items-end" : "items-start",
  ]}
  data-role={message.role}
>
  <div
    class={[
      "max-w-[85%] rounded-lg px-3 py-2 text-sm leading-relaxed",
      isUser ? "bg-primary text-primary-foreground" : "bg-card text-card-foreground border border-border",
    ]}
  >
    <MessageParts parts={message.parts} plain={isUser} />
  </div>

  <div
    class="flex gap-2 opacity-0 transition-opacity group-hover/message:opacity-100 focus-within:opacity-100"
  >
    {#if isUser && onedit}
      <button
        type="button"
        class="text-xs text-muted-foreground hover:text-foreground"
        onclick={() => onedit?.({ id: message.id, text: textOf(message) })}
      >
        {m.chat_edit_message()}
      </button>
    {/if}
    {#if !isUser && onregenerate}
      <button
        type="button"
        class="text-xs text-muted-foreground hover:text-foreground"
        onclick={() => onregenerate?.(message)}
      >
        {m.chat_regenerate()}
      </button>
    {/if}
  </div>
</article>

<style>
  /*
   * Off-screen messages skip layout and paint entirely; the size hint keeps the
   * scrollbar from jumping as they enter and leave (PRD §20).
   */
  .contain-message {
    content-visibility: auto;
    contain-intrinsic-size: auto 4rem;
  }
</style>
