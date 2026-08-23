<script lang="ts">
import * as m from "$lib/paraglide/messages";
import type { ComposerState } from "$lib/state/composer.svelte";

/**
 * The message composer (PRD §10, §20).
 *
 * Touch-sized targets and an explicit send button, because the target hardware
 * is a touchscreen convertible where the on-screen keyboard occupies half the
 * usable height (§20).
 */
interface Props {
  composer: ComposerState;
  streaming: boolean;
  onsend: () => void;
  onabort: () => void;
}

let { composer, streaming, onsend, onabort }: Props = $props();

let textarea = $state<HTMLTextAreaElement | null>(null);

function submit(event: SubmitEvent) {
  event.preventDefault();
  if (composer.canSend && !streaming) onsend();
}

/**
 * Enter sends, Shift+Enter breaks the line.
 *
 * Not applied while the IME is composing: on a Danish keyboard, dead-key
 * accents would otherwise send the message mid-character.
 */
function onkeydown(event: KeyboardEvent) {
  if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;

  event.preventDefault();
  if (composer.canSend && !streaming) onsend();
}

// Grow with the content up to a ceiling, so the latest message stays visible
// above the on-screen keyboard (§20).
$effect(() => {
  const element = textarea;
  if (!element) return;

  // Read the draft so this re-runs as it changes.
  composer.draft;
  element.style.height = "auto";
  element.style.height = `${Math.min(element.scrollHeight, 200)}px`;
});
</script>

<form class="flex flex-col gap-2 border-t border-border bg-background p-3" onsubmit={submit}>
  {#if composer.isEditing}
    <div class="flex items-center justify-between text-xs text-muted-foreground">
      <span>{m.chat_editing_notice()}</span>
      <button type="button" class="underline underline-offset-2" onclick={() => composer.cancelEdit()}>
        {m.chat_cancel_edit()}
      </button>
    </div>
  {/if}

  <div class="flex items-end gap-2">
    <textarea
      bind:this={textarea}
      value={composer.draft}
      oninput={(event) => composer.setDraft(event.currentTarget.value)}
      {onkeydown}
      rows="1"
      placeholder={m.chat_composer_placeholder()}
      aria-label={m.chat_composer_label()}
      class="min-h-11 flex-1 resize-none rounded-md border border-input bg-background px-3 py-2.5 text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
    ></textarea>

    {#if streaming}
      <button
        type="button"
        onclick={onabort}
        class="h-11 shrink-0 rounded-md border border-input px-4 text-sm font-medium text-foreground hover:bg-secondary"
      >
        {m.chat_stop()}
      </button>
    {:else}
      <button
        type="submit"
        disabled={!composer.canSend}
        class="h-11 shrink-0 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-50 hover:bg-primary/90"
      >
        {m.chat_send()}
      </button>
    {/if}
  </div>
</form>
