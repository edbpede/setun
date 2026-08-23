<script lang="ts">
import { hasOpenFence, renderMarkdown } from "$lib/chat/markdown";

/**
 * A settled assistant message, rendered as markdown (PRD §5, §20).
 *
 * Streaming text does not come here — it renders as plain preformatted text in
 * `StreamingMessage`, because re-parsing markdown on every delta is precisely
 * the work the target Chromebook cannot spare (§20).
 *
 * The `{@html}` below is safe by construction: `renderMarkdown` is the only
 * producer of these strings and sanitises with DOMPurify on every path (§5).
 */
interface Props {
  text: string;
}

let { text }: Props = $props();

// Sanitisation needs a DOM, so the server renders the source as plain text and
// the client swaps in markdown on hydration. Model HTML therefore never has a
// server-rendered path to the browser at all.
let rendered = $derived(typeof window === "undefined" ? null : renderMarkdown(text));

// An unclosed fence means the model is mid-block; render it plainly rather than
// letting `marked` guess at a structure that is still arriving (§20).
let incomplete = $derived(hasOpenFence(text));
</script>

{#if rendered && !incomplete}
  <div class="prose-message">
    <!-- eslint-disable-next-line svelte/no-at-html-tags -- sanitised in renderMarkdown -->
    {@html rendered}
  </div>
{:else}
  <p class="whitespace-pre-wrap break-words">{text}</p>
{/if}

<style>
  /*
   * Scoped to rendered markdown, which is `{@html}` output and therefore not
   * reachable by Svelte's scoped class attribution — hence `:global` inside a
   * scoped wrapper rather than utility classes on the elements themselves.
   */
  .prose-message :global(p) {
    margin-block: 0.5rem;
    overflow-wrap: break-word;
  }
  .prose-message :global(p:first-child) {
    margin-block-start: 0;
  }
  .prose-message :global(p:last-child) {
    margin-block-end: 0;
  }
  .prose-message :global(ul),
  .prose-message :global(ol) {
    margin-block: 0.5rem;
    padding-inline-start: 1.5rem;
  }
  .prose-message :global(ul) {
    list-style: disc;
  }
  .prose-message :global(ol) {
    list-style: decimal;
  }
  .prose-message :global(code) {
    font-family: var(--font-mono);
    font-size: 0.875em;
    background: var(--muted);
    padding: 0.1em 0.3em;
    border-radius: calc(var(--radius) - 4px);
  }
  .prose-message :global(pre) {
    margin-block: 0.75rem;
    padding: 0.75rem 1rem;
    background: var(--muted);
    border-radius: calc(var(--radius) - 2px);
    overflow-x: auto;
  }
  .prose-message :global(pre code) {
    background: none;
    padding: 0;
  }
  .prose-message :global(a) {
    color: var(--primary);
    text-decoration: underline;
    text-underline-offset: 2px;
  }
  .prose-message :global(h1),
  .prose-message :global(h2),
  .prose-message :global(h3) {
    font-weight: 600;
    margin-block: 0.75rem 0.375rem;
    line-height: 1.3;
  }
  .prose-message :global(blockquote) {
    border-inline-start: 2px solid var(--border);
    padding-inline-start: 0.75rem;
    color: var(--muted-foreground);
  }
</style>
