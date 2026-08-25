<script lang="ts">
import * as m from "$lib/paraglide/messages";
import type { ArtifactVersionView, ArtifactWorkspace } from "$lib/state/artifacts.svelte";
import ArtifactDiff from "./ArtifactDiff.svelte";
import ArtifactEditor from "./ArtifactEditor.svelte";
import ArtifactFrame from "./ArtifactFrame.svelte";

/**
 * The artifact workspace (PRD §13, §20).
 *
 * Preview, source and history in one panel, over the conversation rather than
 * beside it: usable height on the target device is roughly 640 pixels, so "chat
 * and artifact preview default to tabbed or overlaid rather than side-by-side at
 * this width, with split view available by choice and fullscreen preview as the
 * primary artifact mode" (§20).
 *
 * The panel owns the commit points. A keystroke reaches the workspace and stops
 * there; a Run, or the heavily debounced idle behind it, is what compiles and
 * what stores a revision — "never per keystroke" (§13).
 */

interface Props {
  workspace: ArtifactWorkspace;
  /** A distinct hostname from this one; isolation is by origin (§14). */
  sandboxOrigin: string;
}

let { workspace, sandboxOrigin }: Props = $props();

/**
 * The idle behind the commit. Long on purpose: the compiler worker competes
 * with the interface for one spare core, so a pause in typing is not a request
 * to build (§13, §20).
 */
const IDLE_MS = 3_000;

let versions = $state<ArtifactVersionView[]>([]);
let selectedVersionId = $state<string | null>(null);

const artifact = $derived(workspace.open);
const title = $derived(
  artifact?.title ?? (artifact ? m.artifact_untitled({ language: artifact.language }) : ""),
);

const selected = $derived(versions.find((version) => version.id === selectedVersionId) ?? null);
const previous = $derived.by(() => {
  if (!selected) return null;
  const index = versions.findIndex((version) => version.id === selected.id);
  return index > 0 ? versions[index - 1] : null;
});

const tabs = $derived([
  { value: "preview" as const, label: m.artifact_tab_preview() },
  { value: "code" as const, label: m.artifact_tab_code() },
  { value: "history" as const, label: m.artifact_tab_history() },
]);

const shell = $derived(
  workspace.layout === "split"
    ? "fixed inset-y-0 right-0 z-40 w-full border-l border-border sm:w-1/2"
    : workspace.layout === "fullscreen"
      ? "fixed inset-0 z-50"
      : "fixed inset-0 z-40",
);

/**
 * Store the current source as a revision.
 *
 * "Edits recompile locally with no model request" — this reaches Setun and no
 * further; nothing about it touches the gateway or a student's allowance (§13).
 */
async function store(source: string): Promise<void> {
  const target = workspace.open;
  if (!target || source === target.latest.source) return;

  const response = await fetch(`/api/artifacts/${target.id}/versions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source }),
  }).catch(() => null);

  if (!response?.ok) {
    workspace.saveFailed = true;
    return;
  }

  const version = (await response.json()) as ArtifactVersionView;
  workspace.applyVersion(target.id, version);
  versions = [...versions.filter((existing) => existing.id !== version.id), version];
}

/** A commit point: run what is on screen, and keep it. */
async function commit(): Promise<void> {
  const source = workspace.source;
  workspace.commit();
  await store(source);
}

async function restore(version: ArtifactVersionView): Promise<void> {
  workspace.edit(version.source);
  await commit();
  workspace.view = "preview";
}

async function loadVersions(artifactId: string): Promise<void> {
  const response = await fetch(`/api/artifacts/${artifactId}`).catch(() => null);
  if (!response?.ok) return;

  const body = (await response.json()) as { versions: ArtifactVersionView[] };
  versions = body.versions;
  selectedVersionId = body.versions.at(-1)?.id ?? null;
}

// The heavily debounced idle (§13). Re-armed on every keystroke, so it fires
// once the student stops rather than while they are still typing.
$effect(() => {
  if (workspace.draft === null || !workspace.dirty) return;

  const timer = setTimeout(() => void commit(), IDLE_MS);
  return () => clearTimeout(timer);
});

// History is read when it is opened, and again once a revision lands.
$effect(() => {
  const id = workspace.openId;
  const newest = workspace.open?.latest.id;
  if (!id || workspace.view !== "history" || !newest) return;

  void loadVersions(id);
});
</script>

{#if workspace.visible}
  <section
    class="{shell} flex flex-col bg-background"
    aria-label={m.artifact_panel_title()}
    data-artifact-id={artifact?.id ?? ""}
  >
    <header class="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2">
      <span class="mr-auto min-w-0 truncate text-sm font-medium text-foreground">
        {title || m.artifact_panel_title()}
      </span>

      {#if workspace.items.length > 1}
        <label class="sr-only" for="artifact-select">{m.artifact_select_label()}</label>
        <select
          id="artifact-select"
          value={workspace.openId}
          onchange={(event) => workspace.select(event.currentTarget.value)}
          class="h-8 max-w-32 rounded-md border border-input bg-background px-1.5 text-xs text-foreground"
        >
          {#each workspace.items as item (item.id)}
            <option value={item.id}>
              {item.title ?? m.artifact_untitled({ language: item.language })}
            </option>
          {/each}
        </select>
      {/if}

      <button
        type="button"
        onclick={() => void commit()}
        class="min-h-8 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
      >
        {m.artifact_run()}
      </button>

      <button
        type="button"
        onclick={() =>
          (workspace.layout = workspace.layout === "split" ? "overlay" : "split")}
        aria-pressed={workspace.layout === "split"}
        class="hidden min-h-8 rounded-md border border-input px-2.5 py-1.5 text-xs text-foreground hover:bg-secondary sm:block"
      >
        {m.artifact_layout_split()}
      </button>

      <button
        type="button"
        onclick={() =>
          (workspace.layout = workspace.layout === "fullscreen" ? "overlay" : "fullscreen")}
        aria-pressed={workspace.layout === "fullscreen"}
        class="min-h-8 rounded-md border border-input px-2.5 py-1.5 text-xs text-foreground hover:bg-secondary"
      >
        {m.artifact_layout_fullscreen()}
      </button>

      <button
        type="button"
        onclick={() => workspace.close()}
        class="min-h-8 rounded-md border border-input px-2.5 py-1.5 text-xs text-foreground hover:bg-secondary"
      >
        {m.artifact_close()}
      </button>
    </header>

    {#if artifact}
      <!--
        Tabs rather than three panes: on a 640-pixel screen a second pane costs
        more than it shows (§20). Fullscreen keeps the preview and hides the rest.
      -->
      {#if workspace.layout !== "fullscreen"}
        <div
          role="tablist"
          aria-label={m.artifact_panel_title()}
          class="flex shrink-0 items-center gap-1 border-b border-border px-3 py-1"
        >
          {#each tabs as tab (tab.value)}
            <button
              type="button"
              role="tab"
              id="artifact-tab-{tab.value}"
              aria-controls="artifact-view"
              aria-selected={workspace.view === tab.value}
              onclick={() => (workspace.view = tab.value)}
              class={[
                "min-h-8 rounded-md px-2.5 py-1.5 text-xs font-medium",
                workspace.view === tab.value
                  ? "bg-secondary text-secondary-foreground"
                  : "text-muted-foreground hover:text-foreground",
              ]}
            >
              {tab.label}
            </button>
          {/each}

          <span class="ml-auto min-w-0 truncate pl-2 text-xs text-muted-foreground" role="status">
            {#if workspace.saveFailed}
              {m.artifact_save_failed()}
            {:else if workspace.dirty}
              {m.artifact_status_unsaved()}
            {:else if workspace.status === "compiling"}
              {m.artifact_status_compiling()}
            {:else if workspace.status === "failed"}
              {m.artifact_status_failed()}
            {:else if workspace.status === "running"}
              {m.artifact_status_ready()}
            {/if}
          </span>
        </div>
      {/if}

      <div
        id="artifact-view"
        role="tabpanel"
        aria-labelledby="artifact-tab-{workspace.view}"
        class="min-h-0 flex-1"
      >
        <!--
          The frame stays mounted across tabs: reloading the artifact because a
          pupil looked at its source would throw away whatever state it had.
        -->
        <div
          class={[
            "h-full",
            workspace.view === "preview" || workspace.layout === "fullscreen"
              ? "block"
              : "hidden",
          ]}
        >
          {#if workspace.running !== null}
            <ArtifactFrame
              {sandboxOrigin}
              language={artifact.language}
              source={workspace.running}
              oncompiling={() => (workspace.status = "compiling")}
              onrunning={() => {
                workspace.status = "running";
                workspace.error = null;
              }}
              onfailed={(message) => {
                workspace.status = "failed";
                workspace.error = message;
              }}
            />
          {/if}
        </div>

        {#if workspace.view === "code" && workspace.layout !== "fullscreen"}
          <ArtifactEditor
            value={workspace.source}
            language={artifact.language}
            onchange={(source) => workspace.edit(source)}
          />
        {/if}

        {#if workspace.view === "history" && workspace.layout !== "fullscreen"}
          <div class="flex h-full min-h-0 flex-col sm:flex-row">
            <ul class="max-h-40 shrink-0 overflow-y-auto border-b border-border sm:max-h-none sm:w-44 sm:border-b-0 sm:border-r">
              {#each [...versions].reverse() as version (version.id)}
                <li>
                  <button
                    type="button"
                    onclick={() => (selectedVersionId = version.id)}
                    aria-current={selectedVersionId === version.id}
                    class={[
                      "flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left text-xs",
                      selectedVersionId === version.id
                        ? "bg-secondary text-secondary-foreground"
                        : "text-muted-foreground hover:bg-secondary/50",
                    ]}
                  >
                    <span class="font-medium">
                      {m.artifact_version_label({ revision: version.revision })}
                    </span>
                    <span>
                      {version.authoredBy === "student"
                        ? m.artifact_version_by_student()
                        : m.artifact_version_by_model()}
                    </span>
                  </button>
                </li>
              {/each}
            </ul>

            <div class="flex min-h-0 flex-1 flex-col">
              {#if selected && previous}
                <div class="min-h-0 flex-1 overflow-auto">
                  <ArtifactDiff
                    original={previous.source}
                    revised={selected.source}
                    pairKey={`${previous.id}:${selected.id}`}
                  />
                </div>
              {:else}
                <p class="p-3 text-xs text-muted-foreground">{m.artifact_diff_none()}</p>
              {/if}

              {#if selected}
                <div class="shrink-0 border-t border-border p-2">
                  <button
                    type="button"
                    onclick={() => void restore(selected)}
                    class="min-h-8 rounded-md border border-input px-2.5 py-1.5 text-xs text-foreground hover:bg-secondary"
                  >
                    {m.artifact_restore()}
                  </button>
                </div>
              {/if}
            </div>
          </div>
        {/if}
      </div>

      {#if workspace.error}
        <!-- The compiler's own words. Rendered as text, never as markup (§13, §21). -->
        <pre
          class="max-h-24 shrink-0 overflow-auto border-t border-border bg-destructive/10 p-2 text-xs whitespace-pre-wrap text-foreground"
          role="status">{workspace.error}</pre>
      {/if}

      {#if workspace.editedByStudent}
        <p class="shrink-0 border-t border-border px-2 py-1 text-xs text-muted-foreground">
          {m.artifact_edit_carried()}
        </p>
      {/if}
    {:else}
      <div class="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
        <h2 class="text-base font-semibold text-foreground">{m.artifact_empty_heading()}</h2>
        <p class="max-w-sm text-sm text-muted-foreground">{m.artifact_empty_body()}</p>
      </div>
    {/if}
  </section>
{/if}
