<script lang="ts">
import ArtifactTrit from "$lib/components/artifacts/ArtifactTrit.svelte";
import * as m from "$lib/paraglide/messages";
import type { MessageArtifactRef } from "$lib/state/conversation.svelte";

/**
 * An artifact where its block was written (PRD §13, §20).
 *
 * The transcript used to render an artifact as a fenced code block: a screenful
 * of markup between two sentences, which is what a fence means to a markdown
 * renderer and not what it means here. An artifact is a live document with a
 * panel of its own, so the transcript shows what was built and one control that
 * opens it — the pupil's route from "here is the page" to the page itself is a
 * single tap, which is the whole job of this view on a 640-pixel screen.
 *
 * The identity — id, language, revision — is set in the mono face, everywhere
 * and always, so code-things read as code-things across the interface.
 */
interface Props {
  artifact: MessageArtifactRef;
  onopen?: (artifactId: string) => void;
}

let { artifact, onopen }: Props = $props();

const title = $derived(artifact.title ?? m.artifact_untitled({ language: artifact.language }));
</script>

<div
  class="my-2 flex items-center gap-3 rounded-lg border border-border bg-card px-3 py-2 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1 motion-safe:duration-200"
  data-artifact-card={artifact.artifactId}
>
  <ArtifactTrit status={artifact.buildStatus ?? null} />

  <div class="min-w-0 flex-1">
    <p class="truncate text-sm font-medium text-card-foreground">{title}</p>
    <p class="truncate font-mono text-xs tabular-nums text-muted-foreground">
      {m.artifact_id_label()}={artifact.key} · {artifact.language} · v{artifact.revision}
    </p>
  </div>

  <button
    type="button"
    onclick={() => onopen?.(artifact.artifactId)}
    aria-label={m.artifact_card_label({ title })}
    class="min-h-9 shrink-0 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
  >
    {m.artifact_open()}
  </button>
</div>
