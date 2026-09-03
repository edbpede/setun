<script lang="ts">
import ArrowDown from "@lucide/svelte/icons/arrow-down";
import type { Snippet } from "svelte";
import { untrack } from "svelte";
import { readScrollPosition, writeScrollPosition } from "$lib/chat/viewport";
import * as m from "$lib/paraglide/messages";
import type {
  ChatMessage as ChatMessageData,
  ConversationState,
} from "$lib/state/conversation.svelte";
import ChatMessage from "./ChatMessage.svelte";
import StreamingMessage from "./StreamingMessage.svelte";

/**
 * The conversation itself (PRD §10, §20).
 *
 * The reading surface, and everything that belongs to reading: the window over a
 * long thread, where the scroll sits across a tab discard, and whether new text
 * should pull the view down.
 *
 * That last one used to be unconditional — every delta scrolled to the bottom —
 * so a pupil scrolling back to reread the paragraph the answer was about was
 * dragged forward a line at a time. The view follows the stream only while the
 * pupil is already at the newest end; step away and it stays where they left it,
 * with one control to come back.
 */
interface Props {
  conversation: ConversationState;
  /** Names the thread whose scroll position is remembered; null before one exists. */
  conversationId: string | null;
  onedit?: (message: { id: string; text: string }) => void;
  onregenerate?: (message: ChatMessageData) => void;
  onswitch?: (messageId: string) => void;
  onopenartifact?: (artifactId: string) => void;
  /** Which artifact the build surface is showing, so its card can say so (§13). */
  activeArtifactId?: string | null;
  /** The first-visit surface: shown only while the thread is genuinely empty. */
  empty?: Snippet;
  /** The turn's interactive parts and any refusal, rendered after the stream. */
  footer?: Snippet;
}

let {
  conversation,
  conversationId,
  onedit,
  onregenerate,
  onswitch,
  onopenartifact,
  activeArtifactId = null,
  empty,
  footer,
}: Props = $props();

/** Messages rendered before the window has to be widened by hand (§20). */
const MESSAGE_WINDOW = 30;

/** Within this many pixels of the end counts as "reading the newest" (§20). */
const PINNED_SLACK = 64;

let scroller = $state<HTMLDivElement | null>(null);
let content = $state<HTMLDivElement | null>(null);
let windowSize = $state(MESSAGE_WINDOW);
let pinned = $state(true);

// A different conversation starts at the newest end again (§20).
$effect(() => {
  conversationId;
  untrack(() => {
    windowSize = MESSAGE_WINDOW;
    pinned = true;
  });
});

/** The newest slice of the active path — the rest is behind "show earlier" (§20). */
const visibleMessages = $derived(
  conversation.messages.length > windowSize
    ? conversation.messages.slice(-windowSize)
    : conversation.messages,
);

const hidden = $derived(conversation.messages.length - visibleMessages.length);

const isEmpty = $derived(
  conversation.messages.length === 0 && !conversation.hasPendingAssistantText,
);

function measure(): void {
  const element = scroller;
  if (!element) return;

  pinned = element.scrollHeight - element.scrollTop - element.clientHeight <= PINNED_SLACK;
}

function jumpToLatest(): void {
  const element = scroller;
  if (!element) return;

  pinned = true;
  element.scrollTo({ top: element.scrollHeight, behavior: "auto" });
}

// Keep the newest content in view as it streams — but only for a pupil who is
// already there.
$effect(() => {
  conversation.turn.text;
  conversation.messages.length;
  if (!pinned) return;

  const element = untrack(() => scroller);
  element?.scrollTo({ top: element.scrollHeight });
});

/**
 * Follow the column as it settles, not only as it changes.
 *
 * A turn lands as one data refresh, but the height it produces arrives later: an
 * artifact card animates in, a code block lays out, a generated image loads. The
 * effect above fires on the change and misses all of it, which left the newest
 * card half behind the composer. Watching the column's own size catches every
 * one of them, and still only for a pupil who has not scrolled away.
 */
$effect(() => {
  const inner = content;
  const element = scroller;
  if (!inner || !element || typeof ResizeObserver === "undefined") return;

  const observer = new ResizeObserver(() => {
    if (pinned) element.scrollTo({ top: element.scrollHeight });
  });
  observer.observe(inner);
  return () => observer.disconnect();
});

/**
 * Scroll position across a tab discard (§20).
 *
 * A 4 GB Chromebook discards background tabs routinely. The composer draft
 * already survives one and the in-flight turn resumes from the server; this is
 * the third piece — coming back to where you were reading rather than to the top
 * of the lesson.
 *
 * Restored once per conversation, and only when there is something stored:
 * otherwise the autoscroll above is right and this would fight it.
 */
$effect(() => {
  const element = scroller;
  if (!element || !conversationId) return;

  const stored = untrack(() => readScrollPosition(conversationId));
  if (stored > 0) {
    element.scrollTo({ top: stored });
    untrack(() => measure());
  }

  const remember = () => {
    writeScrollPosition(conversationId, element.scrollTop);
    measure();
  };
  element.addEventListener("scroll", remember, { passive: true });
  return () => element.removeEventListener("scroll", remember);
});
</script>

<div data-transcript class="relative min-h-0 flex-1">
  <div bind:this={scroller} class="h-full overflow-y-auto overscroll-contain">
    <div bind:this={content} class="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 pb-8 pt-5">
      {#if isEmpty && empty}
        {@render empty()}
      {/if}

      {#if hidden > 0}
        <button
          type="button"
          onclick={() => (windowSize += MESSAGE_WINDOW)}
          class="mx-auto min-h-9 rounded-full border border-border px-3 text-xs font-medium text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {m.chat_show_earlier({ count: hidden })}
        </button>
      {/if}

      {#each visibleMessages as message (message.id)}
        <ChatMessage
          {message}
          {onedit}
          {onregenerate}
          {onswitch}
          {onopenartifact}
          {activeArtifactId}
        />
      {/each}

      <StreamingMessage turn={conversation.turn} />

      {@render footer?.()}
    </div>
  </div>

  {#if !pinned && !isEmpty}
    <!--
      One way back to the newest message, for a pupil who has read backwards.
      Over the transcript rather than in the chrome: it belongs to the scroll it
      controls, and it is gone the moment it would do nothing.
    -->
    <button
      type="button"
      onclick={jumpToLatest}
      class="absolute bottom-3 left-1/2 flex size-9 -translate-x-1/2 items-center justify-center rounded-full border border-border bg-card text-muted-foreground shadow-sm hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-safe:animate-in motion-safe:fade-in"
    >
      <ArrowDown size={16} aria-hidden="true" />
      <span class="sr-only">{m.chat_jump_to_latest()}</span>
    </button>
  {/if}
</div>
