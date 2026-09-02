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
  /** Step to the sibling variant at `messageId` — the branch picker (§10). */
  onswitch?: (messageId: string) => void;
  /** Open an artifact this message built, from its card in the transcript (§13). */
  onopenartifact?: (artifactId: string) => void;
}

let { message, onedit, onregenerate, onswitch, onopenartifact }: Props = $props();

let isUser = $derived(message.role === "user");
let branch = $derived(message.branch ?? null);
</script>

<article
  class={[
    "group/message contain-message flex flex-col gap-1",
    isUser ? "items-end" : "items-start",
  ]}
  data-role={message.role}
>
  <!--
    The pupil's words are a bubble; the answer is not (§20). A column of grey
    boxes reads as a form, and on 640 pixels of usable height the box around
    every answer costs a line of the answer itself. A rule in the accent colour
    is enough to say where an answer begins.
  -->
  <div
    class={[
      "text-sm leading-relaxed",
      isUser
        ? "max-w-[85%] rounded-lg bg-primary px-3 py-2 text-primary-foreground"
        : "w-full border-l-2 border-primary/40 pl-3 text-foreground",
    ]}
  >
    <MessageParts
      parts={message.parts}
      plain={isUser}
      artifacts={message.artifacts}
      {onopenartifact}
    />
  </div>

  {#if branch && onswitch}
    <!--
      A branch point: this message has sibling variants an edit or regenerate
      left off-screen. The picker steps between them so the older branch is never
      orphaned (§10). Always visible — unlike the hover actions — because it is
      the only way back to a variant that is not currently shown.
    -->
    <div class="flex items-center gap-1 text-xs text-muted-foreground">
      <button
        type="button"
        class="rounded px-1 hover:text-foreground disabled:opacity-40"
        disabled={branch.prevId === null}
        aria-label={m.chat_branch_previous()}
        onclick={() => branch?.prevId && onswitch?.(branch.prevId)}
      >
        ‹
      </button>
      <span>{branch.index + 1}/{branch.total}</span>
      <button
        type="button"
        class="rounded px-1 hover:text-foreground disabled:opacity-40"
        disabled={branch.nextId === null}
        aria-label={m.chat_branch_next()}
        onclick={() => branch?.nextId && onswitch?.(branch.nextId)}
      >
        ›
      </button>
    </div>
  {/if}

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
