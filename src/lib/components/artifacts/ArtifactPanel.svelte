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
import { rovingTarget } from "$lib/a11y/roving";
import { effectiveArtifactKey, effectiveLanguage } from "$lib/artifacts/identity";
import type { ConsoleLine } from "$lib/artifacts/protocol";
import type { ArtifactLanguage, BuildStatus } from "$lib/artifacts/types";
import * as m from "$lib/paraglide/messages";
import type { ArtifactVersionView, ArtifactWorkspace, PanelTab } from "$lib/state/artifacts.svelte";
import ArtifactDiff from "./ArtifactDiff.svelte";
import ArtifactEditor from "./ArtifactEditor.svelte";
import ArtifactFrame from "./ArtifactFrame.svelte";
import ArtifactIndex from "./ArtifactIndex.svelte";
import ArtifactStatusBar from "./ArtifactStatusBar.svelte";
import ArtifactTrit from "./ArtifactTrit.svelte";

/**
 * The build surface (PRD §13, §20).
 *
 * Preview, source, history and the list of everything built, filling whichever
 * pane the workspace shell gives it. It no longer positions itself: an overlay
 * that covered the conversation meant every question about an artifact started
 * with putting the artifact away, and that was the single worst thing about the
 * flow this replaces.
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
let frame = $state<ReturnType<typeof ArtifactFrame> | null>(null);
let tablist = $state<HTMLDivElement | null>(null);

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

/**
 * The list is a tab of its own, and only where there is a choice to make.
 *
 * With one artifact the index would be a list of one and a control that leads
 * back to where you already are.
 */
const tabs = $derived([
  ...(workspace.items.length > 1
    ? [
        {
          value: "index" as const,
          label: m.artifact_tab_builds({ count: workspace.items.length }),
        },
      ]
    : []),
  { value: "preview" as const, label: m.artifact_tab_preview() },
  { value: "code" as const, label: m.artifact_tab_code() },
  { value: "history" as const, label: m.artifact_tab_history() },
]);

/** The tab actually shown: `index` is unreachable once it stops being offered. */
const tab = $derived<PanelTab>(
  tabs.some((candidate) => candidate.value === workspace.tab) ? workspace.tab : "preview",
);

/**
 * One tab stop for the list, and the arrows move within it.
 *
 * Roving `tabindex` is only half of the tab pattern. Without this the tabs that
 * are not selected carry `tabindex="-1"` and nothing moves the focus off the one
 * that is, so *Code* and *History* are unreachable by keyboard entirely.
 */
function ontablistkeydown(event: KeyboardEvent): void {
  const next = rovingTarget(event, {
    values: tabs.map((candidate) => candidate.value),
    current: tab,
    attribute: "data-tab",
    // A horizontal tab list, so Up and Down are the page's, not this list's.
    orientation: "inline",
  });
  if (!next) return;

  event.preventDefault();
  workspace.tab = next;

  // The moved-to tab keeps the focus, so the next arrow press continues from it.
  // Not the frame, unlike a click: arrowing along the list is looking at what is
  // there, and handing the keyboard to a game halfway would end the journey.
  queueMicrotask(() => {
    tablist?.querySelector<HTMLElement>(`[data-tab="${next}"]`)?.focus();
  });
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
  workspace.tab = "preview";
}

/**
 * Which history request is the current one.
 *
 * Two can be in flight at once and they can land in either order — the pupil
 * moved to another artifact, or a revision of *this* one landed and reopened the
 * effect. Both cases are the same mistake if the loser is what gets assigned, so
 * only the newest request is allowed to write.
 */
let versionsRequest = 0;

async function loadVersions(artifactId: string): Promise<void> {
  const request = ++versionsRequest;

  const response = await fetch(`/api/artifacts/${artifactId}`).catch(() => null);
  if (!response?.ok) return;

  const body = (await response.json()) as { versions: ArtifactVersionView[] };
  if (request !== versionsRequest) return;

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
  if (!id || tab !== "history" || !newest) return;

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

<section
  class="flex h-full min-h-0 flex-col bg-card"
  aria-label={m.artifact_panel_title()}
  data-artifact-id={artifact?.id ?? ""}
>
  {#if workspace.items.length === 0}
    <div class="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
      <h2 class="text-base font-semibold tracking-tight text-card-foreground">
        {m.artifact_empty_heading()}
      </h2>
      <p class="max-w-sm text-sm text-muted-foreground">{m.artifact_empty_body()}</p>
    </div>
  {:else}
    <header class="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
      <div class="mr-auto min-w-0">
        {#if tab === "index" || !artifact}
          <p class="truncate text-sm font-semibold tracking-tight text-card-foreground">
            {m.artifact_index_heading()}
          </p>
        {:else}
          <p class="truncate text-sm font-semibold tracking-tight text-card-foreground">{title}</p>
          <!-- Identity is always the mono face, so code-things read as code-things. -->
          <p class="truncate font-mono text-xs tabular-nums text-muted-foreground">
            {m.artifact_id_label()}={artifactKey} · {workspace.language ??
              artifact.language} · v{artifact.latest.revision}
          </p>
        {/if}
      </div>

      {#if artifact && tab !== "index"}
        <button
          type="button"
          onclick={() => void commit()}
          class="min-h-9 shrink-0 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-card"
        >
          {m.artifact_run()}
        </button>
      {/if}
    </header>

    <div
      bind:this={tablist}
      role="tablist"
      aria-label={m.artifact_panel_title()}
      tabindex="-1"
      onkeydown={ontablistkeydown}
      class="flex shrink-0 items-center gap-1 border-b border-border px-2"
    >
      {#each tabs as candidate (candidate.value)}
        <button
          type="button"
          role="tab"
          id="artifact-tab-{candidate.value}"
          data-tab={candidate.value}
          aria-controls="artifact-view"
          aria-selected={tab === candidate.value}
          tabindex={tab === candidate.value ? 0 : -1}
          onclick={() => {
            workspace.tab = candidate.value;
            if (candidate.value === "preview") focusArtifact();
          }}
          class={[
            "min-h-11 border-b-2 px-2.5 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
            tab === candidate.value
              ? "border-primary text-card-foreground"
              : "border-transparent text-muted-foreground hover:text-card-foreground",
          ]}
        >
          {candidate.label}
        </button>
      {/each}
    </div>

    <div
      id="artifact-view"
      role="tabpanel"
      aria-labelledby="artifact-tab-{tab}"
      class="min-h-0 flex-1"
    >
      {#if tab === "index"}
        <ArtifactIndex
          items={workspace.items}
          openId={workspace.openId}
          onselect={(id) => {
            workspace.show(id);
            workspace.tab = "preview";
          }}
        />
      {/if}

      <!--
        The frame stays mounted across tabs: reloading the artifact because a
        pupil looked at its source would throw away whatever state it had.
      -->
      <div class={["h-full", tab === "preview" ? "block" : "hidden"]}>
        {#if artifact && workspace.running !== null}
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
              // A game is unplayable until its own window has the keyboard, and
              // the pupil is looking at it the moment it renders.
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

      {#if tab === "code" && artifact}
        <!--
          Re-keyed on the language: the editor resolves its grammar once inside
          its attachment and holds no compartment, so a restore that changes the
          tag is only followed by a fresh editor (§13).
        -->
        {#key workspace.language}
          <ArtifactEditor
            value={workspace.source}
            language={workspace.language ?? artifact.language}
            onchange={(source) => workspace.edit(source)}
          />
        {/key}
      {/if}

      {#if tab === "history" && artifact}
        <div class="flex h-full min-h-0 flex-col sm:flex-row">
          <ul
            class="max-h-40 shrink-0 overflow-y-auto border-b border-border sm:max-h-none sm:w-44 sm:border-b-0 sm:border-r"
          >
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
                    <span class="font-mono font-medium tabular-nums">
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
                  class="min-h-9 rounded-md border border-input px-2.5 text-xs text-card-foreground hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {m.artifact_restore()}
                </button>
              </div>
            {/if}
          </div>
        </div>
      {/if}
    </div>

    {#if tab !== "index"}
      <ArtifactStatusBar {workspace} {onaskforhelp} />
    {/if}
  {/if}
</section>
