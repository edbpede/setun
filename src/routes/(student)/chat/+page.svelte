<script lang="ts">
import { enhance } from "$app/forms";
import { invalidateAll } from "$app/navigation";
import { readEventStream } from "$lib/chat/sse-client";
import SetunMark from "$lib/components/brand/SetunMark.svelte";
import ChatMessage from "$lib/components/chat/ChatMessage.svelte";
import Composer from "$lib/components/chat/Composer.svelte";
import ElicitationForm from "$lib/components/chat/ElicitationForm.svelte";
import PermissionPrompt from "$lib/components/chat/PermissionPrompt.svelte";
import StreamingMessage from "$lib/components/chat/StreamingMessage.svelte";
import AllowanceMeter from "$lib/components/classroom/AllowanceMeter.svelte";
import ClassroomClosed from "$lib/components/classroom/ClassroomClosed.svelte";
import * as m from "$lib/paraglide/messages";
import { getLocale } from "$lib/paraglide/runtime";
import { ClassroomState } from "$lib/state/classroom.svelte";
import { ComposerState } from "$lib/state/composer.svelte";
import { ConversationState } from "$lib/state/conversation.svelte";
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

const conversation = new ConversationState();
const composer = new ComposerState();
const classroom = new ClassroomState();

let scroller = $state<HTMLDivElement | null>(null);
let refusal = $state<string | null>(null);
/** True while the composer's image mode is waiting on a picture (§15). */
let generating = $state(false);

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

/** Active fetch controller — cancelled when the student presses Stop. */
let consumeController: AbortController | null = null;

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
    if (headerTurnId) conversation.turn.turnId = headerTurnId;

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

async function send(): Promise<void> {
  const conversationId = conversation.id;
  if (!conversationId) return;

  refusal = null;
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
  const conversationId = conversation.id;
  if (!conversationId) return;

  refusal = null;
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
  const conversationId = conversation.id;
  if (!conversationId) return;

  refusal = null;
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

async function abort(): Promise<void> {
  // Cancel the client-side fetch immediately — this covers the race window
  // before the response header delivers the real turn ID.
  consumeController?.abort();

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
      <div class="hidden w-28 sm:block">
        <AllowanceMeter allowance={status.allowance} compact />
      </div>
      <form method="POST" action="?/create" use:enhance>
        <button
          type="submit"
          class="rounded-md border border-input px-2.5 py-1.5 text-xs font-medium text-foreground hover:bg-secondary"
        >
          {m.chat_new_conversation()}
        </button>
      </form>
      <!--
        The pupil's own language, overriding the classroom setting for them
        alone (§8, §18). It moves to the dashboard when that arrives; it lives
        here now so the setting is reachable at all.
      -->
      <form method="POST" action="?/language" use:enhance class="hidden sm:block">
        <label class="sr-only" for="interface-language">{m.student_language_label()}</label>
        <select
          id="interface-language"
          name="language"
          value={getLocale()}
          onchange={(event) => event.currentTarget.form?.requestSubmit()}
          class="h-7 rounded-md border border-input bg-background px-1.5 text-xs text-foreground"
        >
          <option value="da">{m.educator_language_da()}</option>
          <option value="en">{m.educator_language_en()}</option>
        </select>
      </form>

      <a
        href="/skills"
        class="shrink-0 text-xs text-muted-foreground hover:text-foreground"
      >
        {m.student_skills_link()}
      </a>

      <form method="POST" action="?/logout" use:enhance>
        <button type="submit" class="px-1 text-xs text-muted-foreground hover:text-foreground">
          {m.chat_sign_out()}
        </button>
      </form>
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

      {#each conversation.messages as message (message.id)}
        <ChatMessage
          {message}
          onedit={(target) => composer.beginEdit(target.id, target.text)}
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

  {#if conversation.id}
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
  {/if}
</div>
