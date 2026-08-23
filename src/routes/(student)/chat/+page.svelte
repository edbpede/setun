<script lang="ts">
import { enhance } from "$app/forms";
import { invalidateAll } from "$app/navigation";
import { readEventStream } from "$lib/chat/sse-client";
import SetunMark from "$lib/components/brand/SetunMark.svelte";
import ChatMessage from "$lib/components/chat/ChatMessage.svelte";
import Composer from "$lib/components/chat/Composer.svelte";
import StreamingMessage from "$lib/components/chat/StreamingMessage.svelte";
import * as m from "$lib/paraglide/messages";
import { ComposerState } from "$lib/state/composer.svelte";
import { ConversationState } from "$lib/state/conversation.svelte";
import type { PageProps } from "./$types";

/**
 * The chat route (PRD §10, §20).
 *
 * State containers are instantiated here rather than imported as module
 * singletons: a singleton in a `.svelte.ts` module is shared across every SSR
 * request on the server.
 */
let { data }: PageProps = $props();

const conversation = new ConversationState();
const composer = new ComposerState();

let scroller = $state<HTMLDivElement | null>(null);
let refusal = $state<string | null>(null);

/** Guard: a turn we already consumed or are consuming. */
let consumedTurnId = $state<string | null>(null);

// Re-seed from the server whenever the loaded conversation changes.
$effect(() => {
  conversation.id = data.conversation?.id ?? null;
  conversation.title = data.conversation?.title ?? null;
  conversation.replaceMessages(data.messages);
  composer.attach(data.conversation?.id ?? null);
});

// A turn was still streaming when this tab loaded: replay the buffer and tail
// the live turn — the same endpoint whether it is live or already finished (§10).
//
// `consumedTurnId` breaks the invalidateAll → data refresh → re-fire loop: once
// we've begun consuming a turn, the effect does not start a second consumer even
// though `data.resumeTurnId` may return the same value after invalidateAll.
$effect(() => {
  const turnId = data.resumeTurnId;
  if (!turnId || turnId === consumedTurnId || conversation.turn.streaming) return;

  consumedTurnId = turnId;
  conversation.turn.resume(turnId, -1);
  void consume(`/api/turns/${turnId}/events?after=-1`, { method: "GET" });
});

// Keep the newest content in view as it streams.
$effect(() => {
  conversation.turn.text;
  conversation.messages.length;

  scroller?.scrollTo({ top: scroller.scrollHeight });
});

/** Read an SSE endpoint into the streaming-turn container. */
async function consume(url: string, init: RequestInit): Promise<void> {
  try {
    const response = await fetch(url, init);

    if (response.status === 409) {
      refusal = m.chat_turn_in_flight();
      conversation.turn.detach();
      return;
    }
    if (!response.ok) {
      conversation.turn.apply({ type: "error", message: "unavailable" }, Number.MAX_SAFE_INTEGER);
      conversation.turn.detach();
      return;
    }

    // Extract the real turn ID so abort can target it (replaces the "pending" placeholder).
    const headerTurnId = response.headers.get("x-setun-turn-id");
    if (headerTurnId) conversation.turn.turnId = headerTurnId;

    for await (const { seq, event } of readEventStream(response)) {
      conversation.turn.apply(event, seq);
    }
  } catch {
    // The connection dropped. The turn keeps running on the server and stays
    // resumable, so this is not an error the student needs to see (§10).
    conversation.turn.detach();
  } finally {
    // Pick up the persisted assistant message, the generated title and the new
    // active leaf in one round trip.
    conversation.turn.clear();
    await invalidateAll();
  }
}

async function send(): Promise<void> {
  const conversationId = conversation.id;
  if (!conversationId) return;

  refusal = null;
  const { text, editOfMessageId } = composer.take();
  if (!text) return;

  if (editOfMessageId) conversation.truncateFrom(editOfMessageId);
  conversation.appendUserMessage(text);
  conversation.turn.begin("pending");

  await consume("/api/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      conversationId,
      text,
      ...(editOfMessageId ? { editOfMessageId } : {}),
    }),
  });
}

async function abort(): Promise<void> {
  const turnId = conversation.turn.turnId;
  if (!turnId || turnId === "pending") return;

  await fetch(`/api/turns/${turnId}/abort`, { method: "POST" });
}
</script>

<svelte:head><title>{m.chat_title()} · {m.app_name()}</title></svelte:head>

<div class="flex h-svh flex-col bg-background">
  <!--
    No persistent application header: usable height on the target device is
    roughly 640 pixels, so the chrome is one compact strip (PRD §20).
  -->
  <header class="flex items-center justify-between gap-3 border-b border-border px-3 py-2">
    <div class="flex items-center gap-2 min-w-0">
      <SetunMark size={20} class="shrink-0 text-primary" />
      <span class="truncate text-sm font-medium text-foreground">
        {conversation.title ?? m.chat_untitled_conversation()}
      </span>
    </div>

    <div class="flex shrink-0 items-center gap-2">
      <form method="POST" action="?/create" use:enhance>
        <button
          type="submit"
          class="rounded-md border border-input px-2.5 py-1.5 text-xs font-medium text-foreground hover:bg-secondary"
        >
          {m.chat_new_conversation()}
        </button>
      </form>
      <form method="POST" action="?/logout" use:enhance>
        <button type="submit" class="px-1 text-xs text-muted-foreground hover:text-foreground">
          {m.chat_sign_out()}
        </button>
      </form>
    </div>
  </header>

  <div bind:this={scroller} class="flex-1 overflow-y-auto">
    <div class="mx-auto flex max-w-2xl flex-col gap-4 p-3">
      {#if conversation.messages.length === 0 && !conversation.hasPendingAssistantText}
        <div class="mt-12 flex flex-col items-center gap-2 text-center">
          <SetunMark size={40} class="text-primary" />
          <h1 class="text-base font-semibold text-foreground">{m.chat_empty_heading()}</h1>
          <p class="max-w-xs text-sm text-muted-foreground">{m.chat_empty_body()}</p>
        </div>
      {/if}

      {#each conversation.messages as message (message.id)}
        <ChatMessage
          {message}
          onedit={(target) => composer.beginEdit(target.id, target.text)}
        />
      {/each}

      <StreamingMessage turn={conversation.turn} />

      {#if refusal}
        <p class="text-center text-xs text-muted-foreground" role="status">{refusal}</p>
      {/if}
    </div>
  </div>

  {#if conversation.id}
    <Composer
      {composer}
      streaming={conversation.turn.streaming}
      onsend={send}
      onabort={abort}
    />
  {:else}
    <form method="POST" action="?/create" use:enhance class="border-t border-border p-3">
      <button
        type="submit"
        class="h-11 w-full rounded-md bg-primary text-sm font-medium text-primary-foreground hover:bg-primary/90"
      >
        {m.chat_new_conversation()}
      </button>
    </form>
  {/if}
</div>
