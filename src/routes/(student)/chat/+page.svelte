<script lang="ts">
import { untrack } from "svelte";
import { enhance } from "$app/forms";
import { goto, invalidateAll, replaceState } from "$app/navigation";
import { page } from "$app/state";
import { readEventStream } from "$lib/chat/sse-client";
import { fitVisualViewport, readScrollPosition, writeScrollPosition } from "$lib/chat/viewport";
import ArtifactPanel from "$lib/components/artifacts/ArtifactPanel.svelte";
import SetunMark from "$lib/components/brand/SetunMark.svelte";
import ChatMessage from "$lib/components/chat/ChatMessage.svelte";
import Composer from "$lib/components/chat/Composer.svelte";
import ConversationDrawer from "$lib/components/chat/ConversationDrawer.svelte";
import ElicitationForm from "$lib/components/chat/ElicitationForm.svelte";
import PermissionPrompt from "$lib/components/chat/PermissionPrompt.svelte";
import StreamingMessage from "$lib/components/chat/StreamingMessage.svelte";
import AllowanceMeter from "$lib/components/classroom/AllowanceMeter.svelte";
import ClassroomClosed from "$lib/components/classroom/ClassroomClosed.svelte";
import * as m from "$lib/paraglide/messages";
import { ArtifactWorkspace } from "$lib/state/artifacts.svelte";
import { ClassroomState } from "$lib/state/classroom.svelte";
import { ComposerState } from "$lib/state/composer.svelte";
import {
  type ChatMessage as ChatMessageData,
  ConversationState,
  textOf,
} from "$lib/state/conversation.svelte";
import { attachmentRefusalMessage, imageRefusalMessage, refusalMessage } from "$lib/state/refusals";
import type { PageProps } from "./$types";

/**
 * The chat route (PRD §10, §20).
 *
 * State containers are instantiated here rather than imported as module
 * singletons: a singleton in a `.svelte.ts` module is shared across every SSR
 * request on the server.
 */
let { data }: PageProps = $props();

/** Messages rendered before the window has to be widened by hand (§20). */
const MESSAGE_WINDOW = 30;

const conversation = new ConversationState();
const composer = new ComposerState();
const classroom = new ClassroomState();
const artifacts = new ArtifactWorkspace();

let scroller = $state<HTMLDivElement | null>(null);
let refusal = $state<string | null>(null);
/** The conversation list, which is an overlay rather than a permanent column (§20). */
let drawerOpen = $state(false);
/**
 * How many messages of the active path are rendered (§20).
 *
 * "Long conversations are windowed." A lesson-long thread is hundreds of
 * messages, each with its own markdown render and highlight pass, and a device
 * with one spare core cannot afford to lay all of them out to show the last
 * five. Earlier messages are one click away and cost nothing until asked for.
 */
let windowSize = $state(MESSAGE_WINDOW);
/** True while the composer's image mode is waiting on a picture (§15). */
let generating = $state(false);

/**
 * The model the next conversation will be created with (§9).
 *
 * An alias is bound to a conversation when it is created and the messages in one
 * were answered by that model, so the choice sits beside *New conversation*
 * rather than over a thread already under way. The first message of a visit
 * mints its conversation and carries the same value.
 *
 * Presentation only. Both `?/create` and `POST /api/conversations` fall back to
 * an allowlisted alias whatever a client sends: hiding a control is never access
 * control, and neither is trusting one (§8, §21).
 */
let selectedAliasId = $state<string | null>(null);

const activeAlias = $derived(data.aliases.find((alias) => alias.id === data.modelAliasId) ?? null);

// Default to the first allowlisted alias, and drop a choice the educator has
// since withdrawn rather than sending an id the server will refuse.
$effect(() => {
  const available = data.aliases;
  if (available.length === 0) return;
  if (!selectedAliasId || !available.some((alias) => alias.id === selectedAliasId)) {
    selectedAliasId = available[0].id;
  }
});

/**
 * The status the page renders.
 *
 * The load wins whenever the page data is refreshed — every turn ends with an
 * `invalidateAll`, so the allowance figure is exact then — and the channel
 * carries it in between, which is what makes a lock visible without a reload.
 */
const status = $derived(classroom.status ?? data.status);

/** Guard: a turn we already consumed or are consuming. */
let consumedTurnId = $state<string | null>(null);

// The push channel keeps the room's state current, so a pupil sees a lock land
// rather than discovering it by being refused. Enforcement never depends on it:
// the composer may linger for a moment, and the send is refused all the same
// (PRD §6, §8).
$effect(() => classroom.connect());

// Re-seed from the server whenever the loaded conversation changes.
$effect(() => {
  conversation.id = data.conversation?.id ?? null;
  conversation.title = data.conversation?.title ?? null;
  conversation.replaceMessages(data.messages);
  composer.attach(data.conversation?.id ?? null);
  // Uploads that survived a reload; the server is the record of what is pending.
  composer.setAttachments(data.pendingAttachments);
  // A different conversation starts at the newest end again (§20).
  windowSize = MESSAGE_WINDOW;
  drawerOpen = false;
});

/** The newest slice of the active path — the rest is behind "show earlier" (§20). */
const visibleMessages = $derived(
  conversation.messages.length > windowSize
    ? conversation.messages.slice(-windowSize)
    : conversation.messages,
);

// Every turn ends with an `invalidateAll`, so an artifact the model just wrote
// arrives here without a second request. A draft the pupil is typing survives
// unless the revision it was based on has been superseded (§13).
//
// Untracked because `replace` reads the list it is replacing — to tell whether
// the open artifact gained a revision — and an effect that depends on what it
// writes re-runs itself forever.
$effect(() => {
  const next = data.artifacts;
  untrack(() => artifacts.replace(next));
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

/**
 * Scroll position across a tab discard (§20).
 *
 * A 4 GB Chromebook discards background tabs routinely. The composer draft
 * already survives one and the in-flight turn resumes from the server; this is
 * the third piece — coming back to where you were reading rather than to the
 * top of the lesson.
 *
 * Restored once per conversation, and only when there is something stored:
 * otherwise the autoscroll above is right and this would fight it.
 */
$effect(() => {
  const element = scroller;
  const conversationId = data.conversation?.id ?? null;
  if (!element || !conversationId) return;

  const stored = untrack(() => readScrollPosition(conversationId));
  if (stored > 0) element.scrollTo({ top: stored });

  const remember = () => writeScrollPosition(conversationId, element.scrollTop);
  element.addEventListener("scroll", remember, { passive: true });
  return () => element.removeEventListener("scroll", remember);
});

/** Active fetch controller — cancelled when the student presses Stop. */
let consumeController: AbortController | null = null;

// Stop was pressed before the response delivered the turn id. We cannot abort a
// turn we cannot name — and the turn is already running on the server the moment
// the POST handler starts it — so we do not cancel the fetch yet: we record the
// intent and issue the abort the instant the id header arrives.
let abortRequested = false;

/** Read an SSE endpoint into the streaming-turn container. */
async function consume(url: string, init: RequestInit): Promise<void> {
  consumeController = new AbortController();
  try {
    const response = await fetch(url, { ...init, signal: consumeController.signal });

    if (response.status === 409) {
      refusal = m.chat_turn_in_flight();
      conversation.turn.detach();
      return;
    }
    if (response.status === 403) {
      // The server refused this turn — locked, out of hours, an alias the class
      // may not use, or an exhausted allowance. A friendly sentence, chosen
      // from a code: no server string is ever shown to a pupil (§8, §10, §21).
      const body = await response.json().catch(() => null);
      refusal = refusalMessage(body?.error);
      conversation.turn.detach();
      await invalidateAll();
      return;
    }
    if (!response.ok) {
      conversation.turn.apply({ type: "error", message: "unavailable" }, Number.MAX_SAFE_INTEGER);
      conversation.turn.detach();
      return;
    }

    // Extract the real turn ID so abort can target it (replaces the "pending" placeholder).
    const headerTurnId = response.headers.get("x-setun-turn-id");
    if (headerTurnId) {
      conversation.turn.turnId = headerTurnId;
      // Stop was pressed while the id was still "pending": now that we can name
      // the turn, tell the server to stop it and drop the local stream. Without
      // this the detached server turn would run to completion and the
      // invalidateAll below would resume it.
      if (abortRequested) {
        abortRequested = false;
        // Await the abort before returning: the finally below runs
        // invalidateAll, and if the server had not yet marked the turn stopped
        // the reload would report it as resumable and the resume effect would
        // reconnect to the very turn we just stopped.
        await fetch(`/api/turns/${headerTurnId}/abort`, { method: "POST" });
        consumeController?.abort();
        return;
      }
    }

    for await (const { seq, event } of readEventStream(response, consumeController.signal)) {
      conversation.turn.apply(event, seq);
    }
  } catch {
    // The connection dropped or was aborted. The turn keeps running on the
    // server and stays resumable, so this is not an error the student needs
    // to see (§10).
    conversation.turn.detach();
  } finally {
    consumeController = null;
    // Pick up the persisted assistant message, the generated title and the new
    // active leaf in one round trip.
    conversation.turn.clear();
    await invalidateAll();
  }
}

/**
 * The mint already in flight, so simultaneous callers join one rather than each
 * starting their own (§10).
 *
 * A pupil who picks three files at once calls `attach` three times before any of
 * them has awaited anything, so without this all three would pass the
 * `conversation.id` check below and create a conversation of their own. The
 * uploads would then name three different conversations — only the last of which
 * the composer writes into — so two attachments would be missing from the message
 * they were picked for and left holding conversations nobody is in.
 */
let minting: Promise<string | null> | null = null;

/**
 * The conversation this composer writes into, minting one if there is none (§10).
 *
 * A pupil's very first visit has no conversation, and the empty state tells them
 * to "write a message below". Before this the composer was withheld until they
 * found a *New conversation* button first — the page asked for something it had
 * not provided. The conversation is a container the pupil never asked for, so it
 * is created when they first need one rather than made a step they must take.
 *
 * Still lazy: arriving and leaving without typing mints nothing.
 *
 * Returns null when the server refuses — closed, out of hours, or no allowlisted
 * alias — with the refusal already on screen. Hiding the composer was never the
 * control; this endpoint applies the same guard the send path does (§8, §21).
 */
async function ensureConversation(): Promise<string | null> {
  if (conversation.id) return conversation.id;

  minting ??= mintConversation();
  try {
    return await minting;
  } finally {
    // Cleared either way. A refusal is this attempt's answer, not the answer
    // every later attempt is handed back.
    minting = null;
  }
}

/** The request itself; `ensureConversation` is what decides whether to make one. */
async function mintConversation(): Promise<string | null> {
  const response = await fetch("/api/conversations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(selectedAliasId ? { modelAliasId: selectedAliasId } : {}),
  }).catch(() => null);

  if (!response?.ok) {
    const payload = await response?.json().catch(() => null);
    refusal = refusalMessage(payload?.error);
    return null;
  }

  const { id } = (await response.json()) as { id: string };
  conversation.id = id;
  // `adopt`, not `attach`: the draft on screen is what we are about to send, and
  // attaching would restore the (empty) draft of a conversation created a
  // moment ago and discard it.
  composer.adopt(id);

  // Name the conversation in the URL, without navigating, so a reload lands on
  // the thread the pupil is in rather than on whichever is newest.
  replaceState(`/chat?c=${id}`, page.state);
  return id;
}

async function send(): Promise<void> {
  refusal = null;
  const conversationId = await ensureConversation();
  if (!conversationId) return;

  const { text, editOfMessageId } = composer.take();
  if (!text) return;

  if (editOfMessageId) conversation.truncateFrom(editOfMessageId);
  conversation.appendUserMessage(
    text,
    composer.attachments.map((file) => ({
      type: "attachment" as const,
      attachmentId: file.id,
      kind: file.kind,
      filename: file.filename,
      mediaType: file.mediaType,
    })),
  );
  abortRequested = false;
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

/**
 * Ask the same question again, and keep the first answer (§10).
 *
 * There was no way to a different answer but rewriting the question, and a
 * pupil who rewrote it lost the wording that had produced the answer they were
 * comparing against.
 *
 * The prompt is re-sent as a sibling of itself — the same branching an edit
 * performs, with the text unchanged — so the previous answer is not overwritten
 * but moved onto a branch the picker steps back to. That is the only shape the
 * message tree has for "two answers to one question", and it is the shape §10
 * already describes.
 *
 * The prompt is the message above this one on the active path, which is what
 * `parentId` says on the server; the client is handed the path in order and
 * reads it from there rather than carrying a second copy of the tree.
 */
async function regenerate(assistant: ChatMessageData): Promise<void> {
  if (conversation.turn.streaming) return;

  const index = conversation.messages.findIndex((message) => message.id === assistant.id);
  const prompt = conversation.messages
    .slice(0, index)
    .findLast((message) => message.role === "user");

  const text = prompt ? textOf(prompt) : "";
  if (!prompt || !text) return;

  composer.beginEdit(prompt.id, text);
  await send();
}

/**
 * Answer a question the running turn asked (§11).
 *
 * The turn is running detached from the request that started it, so the answer
 * goes to its own endpoint rather than back up the stream that asked.
 */
async function respond(body: Record<string, unknown>): Promise<void> {
  const turnId = conversation.turn.turnId;
  if (!turnId || turnId === "pending") return;

  await fetch(`/api/turns/${turnId}/respond`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => {
    // The turn will time the question out on its own and continue without the
    // tool, so a failed answer is not something to interrupt a pupil with (§11).
  });
}

/** Upload one file as the pupil picks it, so the send carries only identifiers (§10). */
async function attach(file: File): Promise<void> {
  refusal = null;
  const conversationId = await ensureConversation();
  if (!conversationId) return;

  const body = new FormData();
  body.set("file", file);
  body.set("conversationId", conversationId);

  const response = await fetch("/api/attachments", { method: "POST", body }).catch(() => null);

  if (!response?.ok) {
    const payload = await response?.json().catch(() => null);
    refusal = attachmentRefusalMessage(payload?.error);
    return;
  }

  composer.addAttachment(await response.json());
}

async function detach(attachmentId: string): Promise<void> {
  await fetch(`/api/attachments/${attachmentId}`, { method: "DELETE" }).catch(() => null);
  composer.removeAttachment(attachmentId);
}

/**
 * The composer's explicit image mode (§15).
 *
 * The second trigger path: it converges on the same server-side execution the
 * agent loop's tool reaches, so there is nothing to do here but ask and reload.
 */
async function generateImage(): Promise<void> {
  refusal = null;
  const conversationId = await ensureConversation();
  if (!conversationId) return;

  const { text } = composer.take();
  if (!text) return;

  generating = true;
  try {
    const response = await fetch("/api/images", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ conversationId, prompt: text }),
    }).catch(() => null);

    if (!response?.ok) {
      const payload = await response?.json().catch(() => null);
      refusal =
        response?.status === 403
          ? refusalMessage(payload?.error)
          : imageRefusalMessage(payload?.error);
      return;
    }

    await invalidateAll();
  } finally {
    generating = false;
  }
}

/**
 * Step to a sibling variant of a branched message (§10).
 *
 * The server moves the conversation's active leaf to the tip of the chosen
 * branch; invalidateAll then re-renders the whole branch — messages, artifacts
 * and the branch picker's own position — in one round trip. Not while a turn is
 * streaming: the leaf is about to move on its own.
 */
async function switchBranch(messageId: string): Promise<void> {
  const conversationId = conversation.id;
  if (!conversationId || conversation.turn.streaming) return;

  const response = await fetch(`/api/conversations/${conversationId}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ activeLeafOf: messageId }),
  });
  if (response.ok) await invalidateAll();
}

/**
 * Delete one of the pupil's own conversations (§16).
 *
 * "Students see only their own conversations", and what they can see they can
 * remove: the endpoint is owner-scoped in SQL and cascades to messages, turns,
 * buffered events and the search index, so nothing is left searchable by nobody.
 * The drawer asks before calling this.
 *
 * Deleting the conversation on screen leaves nothing to show, so the page starts
 * fresh rather than silently jumping to a neighbouring thread.
 */
async function deleteConversation(conversationId: string): Promise<void> {
  const response = await fetch(`/api/conversations/${conversationId}`, {
    method: "DELETE",
  }).catch(() => null);

  if (!response?.ok) {
    refusal = m.chat_refusal_unavailable();
    return;
  }

  if (conversationId === conversation.id) {
    // Nothing left to show on this page; the load falls back to the newest
    // conversation the pupil still has, or to an empty composer if none remain.
    await goto("/chat", { invalidateAll: true, noScroll: true });
    return;
  }
  await invalidateAll();
}

/**
 * Open an artifact from its card in the transcript (§13, §20).
 *
 * The pupil's route from "here is the page" to the page is one tap. An artifact
 * the conversation no longer holds — deleted from the gallery, or on a branch
 * that is not on screen — simply does nothing rather than opening an empty panel.
 */
function openArtifact(artifactId: string): void {
  if (!artifacts.items.some((item) => item.id === artifactId)) return;

  artifacts.visible = true;
  artifacts.show(artifactId);
}

/**
 * Hand a failure back to the model (§13).
 *
 * The error is already recorded against the version by the time this is
 * reachable, so the next turn's prompt states it; this only puts the sentence in
 * the composer and gets the panel out of the way. The overlay is closed because
 * it covers the composer; a split panel does not, so it stays.
 */
function askForHelp(): void {
  composer.setDraft(m.artifact_fix_request());
  if (artifacts.layout !== "split") artifacts.close();
}

async function abort(): Promise<void> {
  const turnId = conversation.turn.turnId;

  // The id has arrived: tell the server to stop, then drop the local stream.
  if (turnId && turnId !== "pending") {
    abortRequested = false;
    consumeController?.abort();
    await fetch(`/api/turns/${turnId}/abort`, { method: "POST" });
    return;
  }

  // Still "pending" — the response header has not delivered the turn id yet
  // (the server is preparing the turn, e.g. resolving tools). Record the intent
  // and let the fetch continue; `consume` fires the abort the moment the id
  // header lands. Cancelling the fetch here would lose the header and orphan a
  // turn that is already running server-side — the bug this replaces.
  abortRequested = true;
}
</script>

<svelte:head><title>{m.chat_title()} · {m.app_name()}</title></svelte:head>

<ConversationDrawer
  conversations={data.conversations}
  activeId={data.conversation?.id ?? null}
  open={drawerOpen}
  onclose={() => (drawerOpen = false)}
  ondelete={deleteConversation}
>
  {#snippet footer()}
    <a
      href="/creations"
      class="flex min-h-11 items-center rounded-md px-2 text-xs text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {m.creations_link()}
    </a>
    <a
      href="/skills"
      class="flex min-h-11 items-center rounded-md px-2 text-xs text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {m.student_skills_link()}
    </a>
    <form method="POST" action="?/logout" use:enhance>
      <button
        type="submit"
        class="flex min-h-11 w-full items-center rounded-md px-2 text-left text-xs text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {m.chat_sign_out()}
      </button>
    </form>
  {/snippet}
</ConversationDrawer>

<!--
  Sized to the visual viewport rather than to `100svh`, so the on-screen keyboard
  in tablet mode pushes the composer up instead of covering it (§20).
-->
<div class="flex h-svh flex-col bg-background" {@attach fitVisualViewport}>
  <!--
    No persistent application header: usable height on the target device is
    roughly 640 pixels, so the chrome is one compact strip (PRD §20).
  -->
  <header
    class="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2"
  >
    <div class="flex w-full min-w-0 items-center gap-2 sm:w-auto sm:flex-1">
      <!-- Opens the conversation list. Touch-sized, because the device is a touchscreen (§20). -->
      <button
        type="button"
        onclick={() => (drawerOpen = true)}
        aria-expanded={drawerOpen}
        class="flex size-9 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground"
      >
        <span class="sr-only">{m.chat_conversations()}</span>
        <SetunMark size={20} class="text-primary" />
      </button>
      <span class="truncate text-sm font-medium text-foreground">
        {conversation.title ?? m.chat_untitled_conversation()}
      </span>
    </div>

    <div
      class="flex w-full min-w-0 flex-wrap items-center gap-2 sm:w-auto sm:shrink-0 sm:flex-nowrap"
    >
      <!--
        Which model this conversation is using (§9).
        Read-only, because an alias is bound to a conversation when it is created
        and every message already in one was answered by that model. The choice
        is made beside *New conversation*, where it applies.

        Only the friendly name ever appears — the gateway identifier behind it is
        editable in the panel and reaches no pupil's browser (§9, §21).
      -->
      {#if activeAlias && data.aliases.length > 1}
        <span class="hidden text-xs text-muted-foreground sm:inline">
          {m.chat_model_in_use({ model: activeAlias.name })}
        </span>
      {/if}

      <div class="hidden w-28 sm:block">
        <AllowanceMeter allowance={status.allowance} compact />
      </div>

      <form method="POST" action="?/create" use:enhance class="flex items-center gap-1.5">
        <!--
          The model the next conversation will use. Inside this form so the
          choice travels with the button that acts on it, and so it works with
          JavaScript off; the same value is sent when a conversation is minted by
          the first message instead.

          Only where the educator has allowlisted more than one alias: a picker
          with one option is a control that decides nothing (§9).
        -->
        {#if data.aliases.length > 1}
          <label class="hidden items-center gap-1.5 sm:flex">
            <span class="sr-only">{m.chat_model_label()}</span>
            <select
              name="modelAliasId"
              bind:value={selectedAliasId}
              class="h-8 rounded-md border border-input bg-background px-1.5 text-xs text-foreground"
            >
              {#each data.aliases as alias (alias.id)}
                <option value={alias.id}>{alias.name}</option>
              {/each}
            </select>
          </label>
        {/if}

        <button
          type="submit"
          class="rounded-md border border-input px-2.5 py-1.5 text-xs font-medium text-foreground hover:bg-secondary"
        >
          {m.chat_new_conversation()}
        </button>
      </form>
      <!--
        The Build entry point. Prominent and always present rather than an
        obscure toggle, and it opens whether or not anything has been built —
        the empty panel is where a pupil learns that building is a thing (§13).
      -->
      <!--
        The primary action of this strip: everything else on the row is context,
        and the four navigation links have moved into the drawer, which is where
        a pupil goes between lessons rather than during one (§20).
      -->
      <button
        type="button"
        onclick={() => artifacts.toggle()}
        aria-expanded={artifacts.visible}
        class="relative min-h-9 shrink-0 rounded-md bg-primary px-2.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {m.artifact_build()}{artifacts.items.length > 0 ? ` (${artifacts.items.length})` : ""}
        {#if artifacts.unseen}
          <!-- Something was built while the panel was closed (§13). -->
          <span
            class="absolute -right-0.5 -top-0.5 size-2.5 rounded-full bg-destructive ring-2 ring-background"
          >
            <span class="sr-only">{m.artifact_build_unseen()}</span>
          </span>
        {/if}
      </button>
    </div>
  </header>

  {#if !status.open}
    <!--
      Closed: the status screen replaces the conversation entirely (§8). Hiding
      the composer is a courtesy, not the control — every send is refused by the
      server whether or not this tab ever heard about the lock (§21).
    -->
    <ClassroomClosed {status} />
  {:else}
  <div bind:this={scroller} class="flex-1 overflow-y-auto">
    <div class="mx-auto flex max-w-2xl flex-col gap-4 p-3">
      {#if conversation.messages.length === 0 && !conversation.hasPendingAssistantText}
        <div class="mt-12 flex flex-col items-center gap-2 text-center">
          <SetunMark size={40} class="text-primary" />
          <h1 class="text-base font-semibold text-foreground">{m.chat_empty_heading()}</h1>
          <p class="max-w-xs text-sm text-muted-foreground">{m.chat_empty_body()}</p>
        </div>
      {/if}

      {#if conversation.messages.length > visibleMessages.length}
        <button
          type="button"
          onclick={() => (windowSize += MESSAGE_WINDOW)}
          class="mx-auto min-h-11 rounded-md border border-input px-3 text-xs font-medium text-muted-foreground hover:bg-secondary hover:text-foreground"
        >
          {m.chat_show_earlier({
            count: conversation.messages.length - visibleMessages.length,
          })}
        </button>
      {/if}

      {#each visibleMessages as message (message.id)}
        <ChatMessage
          {message}
          onedit={(target) => composer.beginEdit(target.id, target.text)}
          onregenerate={regenerate}
          onswitch={switchBranch}
          onopenartifact={openArtifact}
        />
      {/each}

      <StreamingMessage turn={conversation.turn} />

      <!--
        The turn's only interactive parts. Rendered inline in the conversation
        rather than as a dialog: on a 640-pixel screen a modal covers the answer
        the pupil is deciding about (§11, §20).
      -->
      {#if conversation.turn.permission}
        {#key conversation.turn.permission.toolCallId}
          <PermissionPrompt
            permission={conversation.turn.permission}
            onrespond={(approved) =>
              respond({
                requestId: conversation.turn.permission?.toolCallId,
                kind: "permission",
                approved,
              })}
          />
        {/key}
      {/if}

      {#if conversation.turn.elicitation}
        {#key conversation.turn.elicitation.toolCallId}
          <ElicitationForm
            elicitation={conversation.turn.elicitation}
            onrespond={(answer) =>
              respond({
                requestId: conversation.turn.elicitation?.toolCallId,
                kind: "elicitation",
                ...answer,
              })}
          />
        {/key}
      {/if}

      {#if generating}
        <p class="text-center text-xs text-muted-foreground" role="status">
          {m.chat_image_generating()}
        </p>
      {/if}

      {#if refusal}
        <p class="text-center text-xs text-muted-foreground" role="status">{refusal}</p>
      {/if}
    </div>
  </div>

  <!--
    Always present, including on a pupil's very first visit: the empty state says
    "write a message below", and the conversation it needs is minted on the first
    send rather than demanded of the pupil first (§10). The header keeps its own
    *New conversation* control for starting a second one, and is the affordance
    that still works with JavaScript off.
  -->
  <Composer
    {composer}
    streaming={conversation.turn.streaming || generating}
    attachmentsEnabled={data.attachmentsEnabled}
    imageModeAvailable={data.imageModeAvailable}
    onsend={() => (composer.mode === "image" ? generateImage() : send())}
    onabort={abort}
    onattach={attach}
    ondetach={detach}
  />
  {/if}

  <!--
    Over the conversation rather than beside it: at 1366x768 a second column
    costs more than it shows, so split view is a choice and not the default (§20).
  -->
  <ArtifactPanel
    workspace={artifacts}
    sandboxOrigin={data.sandboxOrigin}
    onaskforhelp={askForHelp}
  />
</div>
