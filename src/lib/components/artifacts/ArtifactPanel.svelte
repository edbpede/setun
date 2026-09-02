<script lang="ts" module>
/**
 * Reports are sent one at a time, in the order they were raised.
 *
 * One run can produce two of them — `ok` when the page mounts, `threw` when it
 * breaks a moment later — against the same version. Sent concurrently they can
 * land in either order, and the loser is what the server keeps: the model would
 * then be told a page ran when the pupil is looking at an error, or the reverse.
 * A chain rather than a per-instance field so a panel remounted mid-flight does
 * not start a second one.
 */
let sending: Promise<unknown> = Promise.resolve();
</script>

<script lang="ts">
import { effectiveArtifactKey, effectiveLanguage } from "$lib/artifacts/identity";
import type { ConsoleLine } from "$lib/artifacts/protocol";
import type { ArtifactLanguage, BuildStatus } from "$lib/artifacts/types";
import * as m from "$lib/paraglide/messages";
import {
  type ArtifactVersionView,
  type ArtifactWorkspace,
  CONSOLE_KEPT,
} from "$lib/state/artifacts.svelte";
import ArtifactDiff from "./ArtifactDiff.svelte";
import ArtifactEditor from "./ArtifactEditor.svelte";
import ArtifactFrame from "./ArtifactFrame.svelte";
import ArtifactTrit from "./ArtifactTrit.svelte";

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
 *
 * It also owns the report back. The browser is the only party that knows whether
 * an artifact ran, so a run against the stored source is PATCHed onto that
 * version and the next turn's prompt states it — which is what turns "it does not
 * work" into an error the model can act on.
 */

interface Props {
  workspace: ArtifactWorkspace;
  /** A distinct hostname from this one; isolation is by origin (§14). */
  sandboxOrigin: string;
  /**
   * The pupil asking the model to fix what went wrong; the page pre-fills the
   * composer. The status travels with it: "it did not run" and "it ran, then
   * stopped" are different sentences, and the wrong one contradicts the note the
   * model is given beside it.
   */
  onaskforhelp?: (status: BuildStatus) => void;
}

let { workspace, sandboxOrigin, onaskforhelp }: Props = $props();

/**
 * The idle behind the commit. Long on purpose: the compiler worker competes
 * with the interface for one spare core, so a pause in typing is not a request
 * to build (§13, §20).
 */
const IDLE_MS = 3_000;

let versions = $state<ArtifactVersionView[]>([]);
let selectedVersionId = $state<string | null>(null);
let consoleOpen = $state(false);
let frame = $state<ReturnType<typeof ArtifactFrame> | null>(null);

/** Reports already sent, so a re-render does not PATCH the same outcome twice. */
let reported = $state<string | null>(null);

/**
 * Clear the stamp so a report that did not land can be re-sent — but only while
 * it is still the report the panel owes.
 *
 * One run produces two outcomes, `ok` at the mount and `threw` a moment later,
 * and they are sent along one chain. Clearing unconditionally when the first
 * fails would reopen the effect on a stamp the *second* already holds, and the
 * second would be PATCHed twice. A superseded report has nothing to retry: the
 * outcome it described is no longer the one the panel is reporting.
 */
function release(stamp: string): void {
  if (reported === stamp) reported = null;
}

const artifact = $derived(workspace.open);
const title = $derived(
  artifact?.title ?? (artifact ? m.artifact_untitled({ language: artifact.language }) : ""),
);
const artifactKey = $derived(
  artifact
    ? (artifact.key ??
        effectiveArtifactKey({ language: artifact.language, id: artifact.id, key: null }))
    : "",
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

/**
 * What the trit shows: this run's outcome if there is one, else what is stored.
 *
 * `threw` is checked before the `running → ok` mapping below: a page that
 * mounted and then threw stays "running" — it is still on screen — and the
 * outcome is the only thing that knows it broke afterwards.
 */
const runStatus = $derived(
  workspace.status === "failed"
    ? ("failed" as const)
    : workspace.outcome?.status === "threw"
      ? ("threw" as const)
      : workspace.status === "running"
        ? ("ok" as const)
        : (artifact?.latest.buildStatus ?? null),
);

const shell = $derived(
  workspace.layout === "split"
    ? "fixed inset-y-0 right-0 z-40 w-full border-l border-border"
    : workspace.layout === "fullscreen"
      ? "fixed inset-0 z-50"
      : "fixed inset-0 z-40",
);

/** Only split view has a width to set; the other two fill what they are given. */
const shellStyle = $derived(
  workspace.layout === "split" ? `width: ${(1 - workspace.splitFraction) * 100}%` : "",
);

/**
 * The split handle, dragged by pointer (§20).
 *
 * "Panel handles are draggable by touch." Pointer events rather than mouse or
 * touch events: one code path covers a finger, a stylus and a trackpad, and
 * `setPointerCapture` keeps the drag alive when the finger leaves the 12-pixel
 * bar — which on a touchscreen it does immediately.
 *
 * The visual bar is thin and the hit area is not: the element is padded out to a
 * finger-sized target, which is the §20 rule for every control here.
 */
function dragSplit(event: PointerEvent): void {
  const handle = event.currentTarget as HTMLElement;
  handle.setPointerCapture(event.pointerId);

  const move = (moved: PointerEvent) => {
    workspace.setSplitFraction(moved.clientX / window.innerWidth);
  };
  const release = () => {
    handle.removeEventListener("pointermove", move);
    handle.removeEventListener("pointerup", release);
    handle.removeEventListener("pointercancel", release);
  };

  handle.addEventListener("pointermove", move);
  handle.addEventListener("pointerup", release);
  handle.addEventListener("pointercancel", release);
}

/** The keyboard equivalent, because a drag is not an accessible-only affordance. */
function nudgeSplit(event: KeyboardEvent): void {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  event.preventDefault();
  workspace.setSplitFraction(workspace.splitFraction + (event.key === "ArrowLeft" ? -0.05 : 0.05));
}

/**
 * Store the current source as a revision.
 *
 * "Edits recompile locally with no model request" — this reaches Setun and no
 * further; nothing about it touches the gateway or a student's allowance (§13).
 */
async function store(source: string, language: ArtifactLanguage | null): Promise<void> {
  const target = workspace.open;
  if (!target) return;
  // Both, because a restore can bring back a source the artifact already holds
  // under a different tag — same text, different pipeline (§13).
  if (source === target.latest.source && language === effectiveLanguage(target, target.latest)) {
    return;
  }

  const response = await fetch(`/api/artifacts/${target.id}/versions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source, language }),
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
  const language = workspace.language;
  workspace.commit();
  await store(source, language);
}

async function restore(version: ArtifactVersionView): Promise<void> {
  // Not `edit`: the revision comes back under the tag it was written with, and
  // an html revision of an artifact since rewritten as a component must not go
  // through the Svelte compiler (§13).
  workspace.restore(version);
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

/**
 * Take the keyboard, unless the pupil is typing something (§13, §20).
 *
 * A canvas game listens on its own window and is unplayable until the frame has
 * focus. Pulling the caret out of the composer or the editor mid-word is worse
 * than a game that needs one tap, so the active element decides.
 */
function focusArtifact(): void {
  const active = document.activeElement;
  const tag = active?.tagName;
  if (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    (active instanceof HTMLElement && active.isContentEditable)
  ) {
    return;
  }

  frame?.focus();
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

/**
 * Report the run onto the version it ran (§13).
 *
 * `pendingBuildReport` is null for a draft the version does not hold and null
 * when the stored status already says this, so the guard here is only against
 * sending the same report twice while the effect re-runs.
 */
$effect(() => {
  const report = workspace.pendingBuildReport;
  if (!report) return;

  const stamp = `${report.versionId}:${report.status}`;
  if (reported === stamp) return;
  reported = stamp;

  sending = sending.then(() =>
    fetch(`/api/artifacts/${report.artifactId}/versions/${report.versionId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ buildStatus: report.status, buildMessage: report.message }),
    })
      .then((response) => {
        // Folded back in either way is wrong: an unrecorded outcome would be
        // re-sent on the next render, and the model would be told nothing.
        if (response.ok) workspace.applyBuildStatus(report);
        else release(stamp);
      })
      .catch(() => release(stamp)),
  );
});
</script>

{#if workspace.visible}
  {#if workspace.layout === "split"}
    <!--
      The split handle (§20). A thin bar with a finger-sized hit area, sitting on
      the panel's leading edge; `touch-action: none` so a drag moves the divider
      rather than scrolling the conversation behind it.
    -->
    <!--
      The ARIA window-splitter pattern: a focusable `separator` with a value is a
      widget, not decoration. The compiler's heuristic reads the element rather
      than the role, so the two rules it raises are suppressed deliberately here.
    -->
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={m.artifact_split_handle()}
      aria-valuenow={Math.round(workspace.splitFraction * 100)}
      aria-valuemin={25}
      aria-valuemax={80}
      tabindex="0"
      onpointerdown={dragSplit}
      onkeydown={nudgeSplit}
      class="split-handle fixed inset-y-0 z-50 hidden w-6 cursor-col-resize sm:block"
      style="right: {(1 - workspace.splitFraction) * 100}%; margin-right: -0.75rem"
    >
      <span class="pointer-events-none absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 bg-border"
      ></span>
    </div>
  {/if}

  <section
    class="{shell} flex flex-col bg-background motion-safe:animate-in motion-safe:duration-200 {workspace.layout ===
    'split'
      ? 'motion-safe:slide-in-from-right-4'
      : 'motion-safe:slide-in-from-bottom-4'}"
    style={shellStyle}
    aria-label={m.artifact_panel_title()}
    data-artifact-id={artifact?.id ?? ""}
  >
    <header class="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2">
      <div class="mr-auto min-w-0">
        <p class="truncate text-base font-semibold tracking-tight text-foreground">
          {title || m.artifact_panel_title()}
        </p>
        {#if artifact}
          <!-- Identity is always the mono face, so code-things read as code-things. -->
          <p class="truncate font-mono text-xs tabular-nums text-muted-foreground">
            {m.artifact_id_label()}={artifactKey} · {workspace.language ??
              artifact.language} · v{artifact.latest.revision}
          </p>
        {/if}
      </div>

      {#if workspace.items.length > 1}
        <label class="sr-only" for="artifact-select">{m.artifact_select_label()}</label>
        <select
          id="artifact-select"
          value={workspace.openId}
          onchange={(event) => workspace.select(event.currentTarget.value)}
          class="h-9 max-w-32 rounded-md border border-input bg-background px-1.5 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
        class="min-h-9 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {m.artifact_run()}
      </button>

      <button
        type="button"
        onclick={() => (workspace.layout = workspace.layout === "split" ? "overlay" : "split")}
        aria-pressed={workspace.layout === "split"}
        class="hidden min-h-9 rounded-md border border-input px-2.5 text-xs text-foreground hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:block"
      >
        {m.artifact_layout_split()}
      </button>

      <button
        type="button"
        onclick={() =>
          (workspace.layout = workspace.layout === "fullscreen" ? "overlay" : "fullscreen")}
        aria-pressed={workspace.layout === "fullscreen"}
        class="min-h-9 rounded-md border border-input px-2.5 text-xs text-foreground hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {m.artifact_layout_fullscreen()}
      </button>

      <button
        type="button"
        onclick={() => workspace.close()}
        class="min-h-9 rounded-md border border-input px-2.5 text-xs text-foreground hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
          class="flex shrink-0 items-center gap-1 border-b border-border px-3"
        >
          {#each tabs as tab (tab.value)}
            <button
              type="button"
              role="tab"
              id="artifact-tab-{tab.value}"
              aria-controls="artifact-view"
              aria-selected={workspace.view === tab.value}
              onclick={() => {
                workspace.view = tab.value;
                if (tab.value === "preview") focusArtifact();
              }}
              class={[
                "min-h-11 border-b-2 px-2.5 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                workspace.view === tab.value
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              ]}
            >
              {tab.label}
            </button>
          {/each}
        </div>

        <!--
          The status strip: the same trit the transcript card and the History list
          use, so build state means one thing everywhere it appears (§13, §20).
        -->
        <div
          class="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5 text-xs"
        >
          <ArtifactTrit status={runStatus} />
          <span class="min-w-0 truncate text-muted-foreground" role="status">
            {#if workspace.saveFailed}
              {m.artifact_save_failed()}
            {:else if workspace.dirty}
              {m.artifact_status_unsaved()}
            {:else if workspace.status === "compiling"}
              {m.artifact_status_compiling()}
            {:else if workspace.status === "failed"}
              {m.artifact_status_failed()}
            {:else if workspace.outcome?.status === "threw"}
              {m.artifact_status_threw()}
            {:else if workspace.status === "running"}
              {m.artifact_status_ready()}
            {:else if runStatus === null}
              {m.artifact_status_not_run()}
            {:else}
              {m.artifact_status_ran()}
            {/if}
          </span>

          {#if workspace.consoleLines.length > 0}
            <button
              type="button"
              onclick={() => (consoleOpen = !consoleOpen)}
              aria-expanded={consoleOpen}
              class="ml-auto min-h-8 shrink-0 rounded-md border border-input px-2 font-mono text-xs tabular-nums text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {m.artifact_console_label({ count: workspace.consoleLines.length })}
            </button>
          {/if}
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
              bind:this={frame}
              {sandboxOrigin}
              artifactId={artifact.id}
              language={workspace.runningLanguage ?? artifact.language}
              source={workspace.running}
              oncompiling={() => (workspace.status = "compiling")}
              onrunning={() => {
                workspace.status = "running";
                workspace.error = null;
                workspace.recordOutcome("ok", null);
                // A game is unplayable until its own window has the keyboard,
                // and the pupil is looking at it the moment it renders.
                focusArtifact();
              }}
              onfailed={(message) => {
                workspace.status = "failed";
                workspace.error = message;
                workspace.recordOutcome("failed", message);
              }}
              onthrew={(message) => {
                // The status stays "running": the page is still on screen, and
                // what changed is that something on it broke.
                workspace.error = message;
                workspace.recordOutcome("threw", message);
              }}
              onconsole={(lines: readonly ConsoleLine[]) => workspace.appendConsole(lines)}
            />
          {/if}
        </div>

        {#if workspace.view === "code" && workspace.layout !== "fullscreen"}
          <!--
            Re-keyed on the language: the editor resolves its grammar once inside
            its attachment and holds no compartment, so a restore that changes
            the tag is only followed by a fresh editor (§13).
          -->
          {#key workspace.language}
            <ArtifactEditor
              value={workspace.source}
              language={workspace.language ?? artifact.language}
              onchange={(source) => workspace.edit(source)}
            />
          {/key}
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
                      "flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                      selectedVersionId === version.id
                        ? "bg-secondary text-secondary-foreground"
                        : "text-muted-foreground hover:bg-secondary/50",
                    ]}
                  >
                    <span class="flex items-center gap-1.5">
                      <ArtifactTrit status={version.buildStatus ?? null} />
                      <span class="font-mono tabular-nums font-medium">
                        {m.artifact_version_label({ revision: version.revision })}
                      </span>
                      {#if version.language && version.language !== artifact.language}
                        <!-- Only when it differs: the tag a revision was written
                             under is otherwise the one already in the header. -->
                        <span class="font-mono text-muted-foreground">{version.language}</span>
                      {/if}
                    </span>
                    <span>
                      {version.authoredBy === "student"
                        ? m.artifact_version_by_student()
                        : m.artifact_version_by_model()}
                    </span>
                    {#if version.buildStatus === "failed"}
                      <span class="text-destructive">{m.artifact_version_build_failed()}</span>
                    {:else if version.buildStatus === "threw"}
                      <span class="text-destructive">{m.artifact_version_build_threw()}</span>
                    {:else if !version.buildStatus}
                      <span>{m.artifact_status_not_run()}</span>
                    {/if}
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
                    class="min-h-9 rounded-md border border-input px-2.5 text-xs text-foreground hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {m.artifact_restore()}
                  </button>
                </div>
              {/if}
            </div>
          </div>
        {/if}
      </div>

      {#if consoleOpen && workspace.consoleLines.length > 0}
        <!--
          What the artifact printed. Text, never markup, at both hops (§13, §21).
        -->
        <div class="shrink-0 border-t border-border">
          <pre
            role="log"
            class="max-h-32 overflow-auto bg-muted p-2 font-mono text-xs whitespace-pre-wrap text-foreground">{workspace.consoleLines
              .map((line) => `${line.level === "log" ? "" : `${line.level}: `}${line.text}`)
              .join("\n")}</pre>
          {#if workspace.consoleLines.length >= CONSOLE_KEPT}
            <!-- A rAF loop with a stray log prints sixty lines a second; the
                 useful ones are the newest, so the older ones are gone. -->
            <p class="px-2 py-1 text-xs text-muted-foreground">
              {m.artifact_console_truncated()}
            </p>
          {/if}
        </div>
      {/if}

      {#if workspace.error}
        <!-- The compiler's own words. Rendered as text, never as markup (§13, §21). -->
        <div class="flex shrink-0 items-start gap-2 border-t border-border bg-destructive/10 p-2">
          <pre
            class="max-h-24 min-w-0 flex-1 overflow-auto text-xs whitespace-pre-wrap text-foreground"
            role="status">{workspace.error}</pre>
          {#if onaskforhelp}
            <!--
              The one thing a pupil can do about an error they cannot read: hand
              it back with the failure already recorded against the version, so
              the next answer is about this error rather than about "it broke".
            -->
            <button
              type="button"
              onclick={() => onaskforhelp?.(workspace.outcome?.status ?? "failed")}
              disabled={workspace.pendingBuildReport !== null}
              class="min-h-9 shrink-0 rounded-md border border-input bg-background px-2.5 text-xs font-medium text-foreground hover:bg-secondary disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {m.artifact_ask_fix()}
            </button>
          {/if}
        </div>
      {/if}

      {#if workspace.editedByStudent}
        <p class="shrink-0 border-t border-border px-2 py-1 text-xs text-muted-foreground">
          {m.artifact_edit_carried()}
        </p>
      {/if}
    {:else}
      <div class="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
        <h2 class="text-base font-semibold tracking-tight text-foreground">
          {m.artifact_empty_heading()}
        </h2>
        <p class="max-w-sm text-sm text-muted-foreground">{m.artifact_empty_body()}</p>
      </div>
    {/if}
  </section>
{/if}

<style>
/* A drag must move the divider, not scroll the page behind it. */
.split-handle {
  touch-action: none;
}
</style>
