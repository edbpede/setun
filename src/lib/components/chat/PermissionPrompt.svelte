<script lang="ts">
import * as m from "$lib/paraglide/messages";
import type { PendingPermission } from "$lib/state/streaming-turn.svelte";
import ToolAttribution from "./ToolAttribution.svelte";

/**
 * "May I use a tool?" (PRD §11, §20).
 *
 * Sits inline in the conversation rather than in a dialog: on a 640-pixel screen
 * a modal covers the answer the pupil is deciding about, and a prompt they can
 * scroll away from is a prompt they can reason about.
 *
 * The arguments are shown, not summarised — a pupil approving a tool call should
 * be approving something specific. They are rendered as text, never as markup:
 * the model wrote them, and a model's output is untrusted (§11, §21).
 *
 * Declining is not a destructive action and is not styled as one: §11 makes it
 * an ordinary answer that the loop continues past.
 */
interface Props {
  permission: PendingPermission;
  onrespond: (approved: boolean) => void;
}

let { permission, onrespond }: Props = $props();

const detail = $derived(
  permission.arguments && Object.keys(permission.arguments as object).length > 0
    ? JSON.stringify(permission.arguments, null, 1)
    : null,
);
</script>

<section
  class="flex max-w-[85%] flex-col gap-2 rounded-lg border border-primary/30 bg-card px-3 py-2.5"
  aria-live="polite"
>
  <ToolAttribution serverLabel={permission.serverLabel} pending />

  <div class="flex flex-col gap-0.5">
    <p class="text-sm font-medium text-foreground">{m.chat_permission_title()}</p>
    <p class="text-sm text-muted-foreground">
      <code class="rounded bg-secondary px-1 py-0.5 text-xs">{permission.toolName}</code>
    </p>
    {#if permission.sensitive}
      <p class="text-xs text-primary">{m.chat_permission_sensitive()}</p>
    {/if}
  </div>

  {#if detail}
    <details class="text-xs">
      <summary class="cursor-pointer text-muted-foreground">{m.chat_permission_details()}</summary>
      <pre
        class="mt-1 max-h-32 overflow-auto whitespace-pre-wrap rounded-md bg-secondary p-2 text-foreground"
      >{detail}</pre>
    </details>
  {/if}

  <div class="flex gap-2">
    <button
      type="button"
      onclick={() => onrespond(true)}
      class="h-11 flex-1 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90"
    >
      {m.chat_permission_approve()}
    </button>
    <button
      type="button"
      onclick={() => onrespond(false)}
      class="h-11 flex-1 rounded-md border border-input px-4 text-sm font-medium text-foreground hover:bg-secondary"
    >
      {m.chat_permission_decline()}
    </button>
  </div>
</section>
