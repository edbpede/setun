<script lang="ts">
import Image from "@lucide/svelte/icons/image";
import Paperclip from "@lucide/svelte/icons/paperclip";
import X from "@lucide/svelte/icons/x";
import * as m from "$lib/paraglide/messages";
import type { ComposerState } from "$lib/state/composer.svelte";

/**
 * The message composer (PRD §10, §15, §20).
 *
 * Touch-sized targets and an explicit send button, because the target hardware
 * is a touchscreen convertible where the on-screen keyboard occupies half the
 * usable height (§20).
 *
 * Two controls sit beside the textarea rather than behind a menu: attaching a
 * file, and the explicit image mode of §15. Image mode changes what the send
 * button does, so it changes the placeholder and the button's own label —
 * a mode the pupil cannot see they are in is a mode they will be surprised by.
 */
interface Props {
  composer: ComposerState;
  streaming: boolean;
  /** Absent when the classroom allows no attachments, or the alias takes none (§10). */
  attachmentsEnabled?: boolean;
  /** Present only where a generation-capable alias is allowlisted (§15). */
  imageModeAvailable?: boolean;
  onsend: () => void;
  onabort: () => void;
  onattach?: (file: File) => void;
  ondetach?: (attachmentId: string) => void;
}

let {
  composer,
  streaming,
  attachmentsEnabled = false,
  imageModeAvailable = false,
  onsend,
  onabort,
  onattach,
  ondetach,
}: Props = $props();

let textarea = $state<HTMLTextAreaElement | null>(null);
let filePicker = $state<HTMLInputElement | null>(null);

const isImageMode = $derived(composer.mode === "image");

function pickFiles(event: Event) {
  const input = event.currentTarget as HTMLInputElement;
  for (const file of input.files ?? []) onattach?.(file);
  // Reset, so choosing the same file twice in a row still fires a change.
  input.value = "";
}

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
  {#if composer.attachments.length > 0}
    <ul class="flex flex-wrap gap-1.5">
      {#each composer.attachments as file (file.id)}
        <li
          class="flex max-w-full items-center gap-1.5 rounded-md border border-border bg-secondary py-1 pl-2 pr-1 text-xs"
        >
          <span class="truncate">{file.filename}</span>
          <button
            type="button"
            onclick={() => ondetach?.(file.id)}
            aria-label={m.chat_attachment_remove({ filename: file.filename })}
            class="grid size-6 shrink-0 place-items-center rounded text-muted-foreground hover:bg-background hover:text-foreground"
          >
            <X size={14} aria-hidden="true" />
          </button>
        </li>
      {/each}
    </ul>
  {/if}

  {#if composer.isEditing}
    <div class="flex items-center justify-between text-xs text-muted-foreground">
      <span>{m.chat_editing_notice()}</span>
      <button type="button" class="underline underline-offset-2" onclick={() => composer.cancelEdit()}>
        {m.chat_cancel_edit()}
      </button>
    </div>
  {/if}

  <div class="flex items-end gap-2">
    {#if attachmentsEnabled}
      <input
        bind:this={filePicker}
        type="file"
        multiple
        class="sr-only"
        onchange={pickFiles}
        aria-hidden="true"
        tabindex="-1"
      />
      <button
        type="button"
        onclick={() => filePicker?.click()}
        aria-label={m.chat_attachment_add()}
        title={m.chat_attachment_add()}
        class="grid size-11 shrink-0 place-items-center rounded-md border border-input text-muted-foreground hover:bg-secondary hover:text-foreground"
      >
        <Paperclip size={18} aria-hidden="true" />
      </button>
    {/if}

    {#if imageModeAvailable}
      <button
        type="button"
        onclick={() => composer.toggleMode()}
        aria-pressed={isImageMode}
        title={isImageMode ? m.chat_image_mode_off() : m.chat_image_mode()}
        class={[
          "grid size-11 shrink-0 place-items-center rounded-md border",
          isImageMode
            ? "border-primary bg-primary text-primary-foreground"
            : "border-input text-muted-foreground hover:bg-secondary hover:text-foreground",
        ]}
      >
        <Image size={18} aria-hidden="true" />
        <span class="sr-only">{isImageMode ? m.chat_image_mode_off() : m.chat_image_mode()}</span>
      </button>
    {/if}

    <textarea
      bind:this={textarea}
      value={composer.draft}
      oninput={(event) => composer.setDraft(event.currentTarget.value)}
      {onkeydown}
      rows="1"
      placeholder={isImageMode ? m.chat_image_placeholder() : m.chat_composer_placeholder()}
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
        {isImageMode ? m.chat_image_mode() : m.chat_send()}
      </button>
    {/if}
  </div>
</form>
