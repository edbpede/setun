<script lang="ts">
import { toolLabel } from "$lib/chat/tool-labels";
import { turnNoticeText } from "$lib/chat/turn-notices";
import * as m from "$lib/paraglide/messages";
import type { MessagePart } from "$lib/server/db/schema";
import MarkdownMessage from "./MarkdownMessage.svelte";
import ToolAttribution from "./ToolAttribution.svelte";

/**
 * One message's content, in the order it happened (PRD §10, §11, §13, §15).
 *
 * The same component renders a turn as it streams and the same turn after a
 * reload, because both are the ordered `MessagePart[]` the server persists. A
 * separate live view is how the two come to disagree about what happened.
 *
 * Prose is plain preformatted text while the turn streams and markdown once it
 * settles: re-parsing and re-highlighting a growing message on every delta is
 * the work that drops frames on the target hardware (§20).
 *
 * The type import is erased at compile time; no server code enters the bundle.
 */
interface Props {
  parts: readonly MessagePart[];
  /** True while the turn is still arriving, which keeps prose unparsed (§20). */
  streaming?: boolean;
  /** User messages are the pupil's own words and are never parsed as markdown. */
  plain?: boolean;
}

let { parts, streaming = false, plain = false }: Props = $props();

const results = $derived(
  parts.filter(
    (part): part is Extract<MessagePart, { type: "tool-result" }> => part.type === "tool-result",
  ),
);

/** Which calls already have a result; the rest are still running. */
const settled = $derived(new Set(results.map((part) => part.toolCallId)));
const failed = $derived(
  new Set(results.filter((part) => part.isError).map((part) => part.toolCallId)),
);
</script>

{#each parts as part, index (index)}
  {#if part.type === "text"}
    {#if plain || streaming}
      <p class="whitespace-pre-wrap break-words">{part.text}</p>
    {:else}
      <MarkdownMessage text={part.text} />
    {/if}
  {:else if part.type === "tool-call"}
    <!--
      One line per tool, with the same attribution device the prompt used, so a
      pupil can see afterwards what ran and who it belonged to (§11).
    -->
    <div class="my-1.5 flex flex-col gap-0.5">
      <ToolAttribution serverLabel={part.serverLabel} />
      <span class="pl-2.5 text-xs text-muted-foreground">
        {#if part.decision === "declined"}
          {m.chat_permission_declined_notice()}
        {:else if !settled.has(part.toolCallId)}
          {m.chat_tool_running({ tool: toolLabel(part.toolName) })}
        {:else if failed.has(part.toolCallId)}
          {m.chat_tool_failed({ tool: toolLabel(part.toolName) })}
        {:else}
          {m.chat_tool_done({ tool: toolLabel(part.toolName) })}
        {/if}
      </span>
    </div>
  {:else if part.type === "generated-image"}
    <!--
      Served by Setun, scoped to its owner. No external image URL ever reaches
      the browser (§15, §21).
    -->
    <img
      src="/api/images/{part.imageId}"
      alt={m.chat_image_alt({ prompt: part.prompt })}
      loading="lazy"
      class="my-1 max-h-80 w-full rounded-md border border-border object-contain"
    />
  {:else if part.type === "artifact-edit"}
    <!--
      The pupil's own current source, carried to the model on this message (§13).
      Shown as a compact reference rather than the code itself: they did not type
      it into the composer, and a wall of markup in the transcript reads as noise.
    -->
    <span
      class="my-0.5 inline-flex max-w-full items-center gap-1.5 rounded-md border border-border bg-secondary px-2 py-1 text-xs"
    >
      <span class="truncate">
        {m.artifact_edit_part_label({
          title: part.title ?? m.artifact_untitled({ language: part.language }),
        })}
      </span>
    </span>
  {:else if part.type === "turn-notice"}
    <!--
      Why the answer stops here: Stop pressed, a per-turn cap reached, a question
      nobody answered. Persisted as a part rather than held in the live turn, so
      it is still there after a reload — a sentence that simply ends, with nothing
      to say it was cut short, is the thing this replaces (§10, §11).
    -->
    <p class="mt-2 text-xs text-muted-foreground">{turnNoticeText(part.notice)}</p>
  {:else if part.type === "attachment"}
    <span
      class="my-0.5 inline-flex max-w-full items-center gap-1.5 rounded-md border border-border bg-secondary px-2 py-1 text-xs"
    >
      <span class="truncate">{part.filename}</span>
    </span>
  {/if}
{/each}
