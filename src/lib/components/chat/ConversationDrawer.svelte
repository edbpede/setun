<script lang="ts">
import * as m from "$lib/paraglide/messages";

/**
 * The conversation list, as an overlay (PRD §18, §20).
 *
 * "Usable height after browser and system chrome is roughly 640 pixels, so there
 * is no persistent application header and the sidebar is an overlay rather than
 * a permanent column" (§20). At 1366 pixels wide a permanent column would cost a
 * quarter of the reading width for a list that is consulted between lessons, not
 * during one.
 *
 * Hand-rolled rather than a dialog primitive: this is a plain panel with a
 * scrim, it must not trap the page in a modal while a turn is streaming behind
 * it, and it costs no additional JavaScript on a route with a 250 KB budget.
 */

interface Conversation {
  id: string;
  title: string | null;
}

interface Props {
  conversations: Conversation[];
  activeId: string | null;
  open: boolean;
  onclose: () => void;
  /** Absent while the drawer is used somewhere deletion does not belong. */
  ondelete?: (conversationId: string) => void;
}

let { conversations, activeId, open, onclose, ondelete }: Props = $props();

/**
 * The row whose delete control is awaiting confirmation (§16).
 *
 * Deleting a conversation removes its messages, turns and buffered events for
 * good, so it asks first. Inline rather than `window.confirm`, which cannot be
 * translated and which a pupil dismisses without reading; and lighter than the
 * type-the-label friction the educator's pupil deletion uses, because this is a
 * pupil deleting their own work and only their own.
 */
let confirming = $state<string | null>(null);

// A conversation that has gone — deleted, or the drawer reopened on a new list —
// must not leave its confirmation armed against whatever now sits in that row.
$effect(() => {
  if (confirming && !conversations.some((c) => c.id === confirming)) confirming = null;
});
</script>

<svelte:window onkeydown={(event) => open && event.key === "Escape" && onclose()} />

{#if open}
  <!-- No backdrop blur (§20): a scrim, not a compositing effect. -->
  <button
    type="button"
    class="fixed inset-0 z-40 bg-black/40"
    aria-label={m.chat_conversations_close()}
    onclick={onclose}
  ></button>

  <aside
    class="fixed inset-y-0 start-0 z-50 flex w-72 max-w-[85vw] flex-col gap-2 border-e border-border bg-background p-3"
  >
    <div class="flex items-center justify-between gap-2">
      <h2 class="text-sm font-medium text-foreground">{m.chat_conversations()}</h2>
      <button
        type="button"
        onclick={onclose}
        class="h-9 rounded-md px-2 text-xs text-muted-foreground hover:bg-secondary hover:text-foreground"
      >
        {m.chat_conversations_close()}
      </button>
    </div>

    <nav class="flex min-h-0 flex-1 flex-col overflow-y-auto">
      {#each conversations as conversation (conversation.id)}
        {@const title = conversation.title ?? m.chat_untitled_conversation()}
        <!-- Touch-sized rows, not compact ones: the target device is a touchscreen (§20). -->
        <div class="group/row flex min-h-11 items-center gap-1 rounded-md pe-1"
          class:bg-secondary={conversation.id === activeId}
        >
          <a
            href="/chat?c={conversation.id}"
            class="flex min-h-11 flex-1 items-center rounded-md px-2 text-sm hover:bg-secondary"
            class:font-medium={conversation.id === activeId}
            aria-current={conversation.id === activeId ? "page" : undefined}
          >
            <span class="truncate text-foreground">{title}</span>
          </a>

          {#if ondelete}
            {#if confirming === conversation.id}
              <button
                type="button"
                onclick={() => {
                  confirming = null;
                  ondelete?.(conversation.id);
                }}
                class="min-h-11 shrink-0 rounded-md px-2 text-xs font-medium text-destructive hover:bg-destructive hover:text-destructive-foreground"
              >
                {m.chat_delete_conversation_confirm()}
              </button>
              <button
                type="button"
                onclick={() => (confirming = null)}
                class="min-h-11 shrink-0 rounded-md px-2 text-xs text-muted-foreground hover:text-foreground"
              >
                {m.chat_delete_conversation_cancel()}
              </button>
            {:else}
              <button
                type="button"
                onclick={() => (confirming = conversation.id)}
                aria-label={m.chat_delete_conversation_aria({ title })}
                class="min-h-11 shrink-0 rounded-md px-2 text-xs text-muted-foreground opacity-0 hover:text-destructive focus-visible:opacity-100 group-hover/row:opacity-100"
              >
                {m.chat_delete_conversation()}
              </button>
            {/if}
          {/if}
        </div>
      {:else}
        <p class="px-2 py-1.5 text-xs text-muted-foreground">{m.chat_empty_heading()}</p>
      {/each}
    </nav>

    <a
      href="/dashboard"
      class="flex min-h-11 items-center rounded-md px-2 text-xs text-muted-foreground hover:bg-secondary hover:text-foreground"
    >
      {m.student_dashboard_link()}
    </a>
  </aside>
{/if}
