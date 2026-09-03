import { type BuildOutcome, type BuildReport, buildReportFor } from "$lib/artifacts/build-report";
import { followModelWrite } from "$lib/artifacts/follow";
import { effectiveLanguage } from "$lib/artifacts/identity";
import type { ConsoleLine } from "$lib/artifacts/protocol";
import type { ArtifactLanguage, BuildStatus, VersionAuthor } from "$lib/artifacts/types";

/**
 * The artifact workspace a student has open (PRD §13, §20).
 *
 * Instantiated per page rather than exported as a module singleton: a singleton
 * in a `.svelte.ts` module is shared across every server render.
 *
 * The source on screen and the source *running* are deliberately two values.
 * Compilation "is triggered by an explicit Run action or a heavily debounced
 * idle, never per keystroke" (§13), so the frame follows `running`, which only
 * advances at a commit point, while the editor moves with every keystroke.
 */

/** The revision the panel is showing, as the server describes it. */
export interface ArtifactVersionView {
  readonly id: string;
  readonly revision: number;
  readonly source: string;
  /** The tag it was written under; null for "whatever the artifact says" (§13). */
  readonly language?: ArtifactLanguage | null;
  readonly authoredBy: VersionAuthor;
  /** How this revision ran the last time anyone pressed Run; null for never (§13). */
  readonly buildStatus?: BuildStatus | null;
  readonly buildMessage?: string | null;
  readonly createdAt: string;
}

export interface ArtifactView {
  readonly id: string;
  readonly language: ArtifactLanguage;
  readonly title: string | null;
  /** The id the model reuses to change it, written or derived (§13). */
  readonly key?: string | null;
  readonly latest: ArtifactVersionView;
}

/**
 * Where the workspace is pointed: at the conversation, at both, or at the build.
 *
 * Setun is named after the 1958 balanced-ternary machine, and the workspace is
 * genuinely three-valued rather than a panel that is open or shut. One control
 * with three positions replaces the three two-way toggles this used to carry —
 * *Build*, *Split view*, *Fullscreen* — which between them described the same
 * three states in a way a pupil had to assemble for themselves.
 *
 * The stage says nothing about geometry. A wide screen lays the two panes out
 * side by side and a narrow one stacks them, but *which* surfaces are on screen
 * is one value in one place (§20).
 */
export type WorkspaceStage = "chat" | "both" | "build";

/** What the build pane is showing. `index` is the list of everything built (§13). */
export type PanelTab = "index" | "preview" | "code" | "history";

export type RunStatus = "idle" | "compiling" | "running" | "failed";

/** The conversation's smallest and largest share of the split (§20). */
export const MIN_FRACTION = 0.3;
export const MAX_FRACTION = 0.72;

/**
 * How many printed lines the panel keeps.
 *
 * A `requestAnimationFrame` loop with a stray `console.log` prints sixty lines a
 * second, and the useful ones are the newest.
 */
export const CONSOLE_KEPT = 200;

export class ArtifactWorkspace {
  items = $state<ArtifactView[]>([]);
  openId = $state<string | null>(null);

  /** Which surfaces are on screen. The one control that governs the layout. */
  stage = $state<WorkspaceStage>("chat");

  /** What the build pane is showing while it is on screen. */
  tab = $state<PanelTab>("preview");

  /**
   * The conversation's share of the split (§20).
   *
   * "Panel handles are draggable by touch." One fraction along whichever axis
   * the shell is using: a fixed half is the wrong half about as often as it is
   * the right one, so the handle moves it and this holds where it was left.
   */
  fraction = $state(0.56);

  /** Clamped so the handle can never drag either side out of existence. */
  setFraction(fraction: number): void {
    this.fraction = Math.min(MAX_FRACTION, Math.max(MIN_FRACTION, fraction));
  }

  /** What the editor holds. Null while the student has not typed anything. */
  draft = $state<string | null>(null);
  /**
   * The tag the draft is written under, when it is not the artifact's own.
   *
   * A Restore is what puts a value here: an html revision of an artifact since
   * rewritten as a component comes back as html, and running it through the
   * Svelte compiler is not a lesson about anything (§13).
   */
  draftLanguage = $state<ArtifactLanguage | null>(null);
  /** What the frame is running. Advances only at a commit point (§13). */
  running = $state<string | null>(null);
  /** And under which tag, snapshotted at the same commit point. */
  runningLanguage = $state<ArtifactLanguage | null>(null);

  status = $state<RunStatus>("idle");
  /** The compiler's or the browser's own words, rendered as text (§13). */
  error = $state<string | null>(null);
  saveFailed = $state(false);

  /**
   * How the last run went, and over which source (§13).
   *
   * The source travels with the outcome because a pupil running an unsaved draft
   * is running something no version holds — stamping the stored revision with
   * that result would tell the model a lie about its own code. The tag travels
   * with it for the same reason: a Restore runs text the version already holds
   * under a tag it does not, and the revision recording that tag is still on its
   * way to the server while the frame is already running.
   */
  outcome = $state<BuildOutcome | null>(null);

  /** What the artifact printed on this run, oldest first (§13). */
  consoleLines = $state<ConsoleLine[]>([]);

  /**
   * An artifact whose model-written revision the pupil has not looked at.
   *
   * The switcher wears it as a badge, so a pupil reading the conversation still
   * learns that something was built.
   */
  unseen = $state<string | null>(null);

  /** True while the build surface is on screen at all. */
  get visible(): boolean {
    return this.stage !== "chat";
  }

  /** True while the conversation is on screen at all. */
  get conversationVisible(): boolean {
    return this.stage !== "build";
  }

  /**
   * Whether the build pane stays in the document while the pupil reads.
   *
   * A running artifact holds state the pupil built up — a score, a board, a form
   * half filled in — and tearing the frame down to glance at the conversation
   * throws all of it away. So the pane is hidden rather than unmounted whenever
   * something is running, and the frame keeps its document (§13).
   */
  get mounted(): boolean {
    return this.visible || this.running !== null;
  }

  /** The PATCH the panel owes the server, or null when it owes none. */
  get pendingBuildReport(): BuildReport | null {
    return buildReportFor(this.open, this.outcome);
  }

  get open(): ArtifactView | null {
    return this.items.find((item) => item.id === this.openId) ?? null;
  }

  /** The current source: the student's edit if there is one, else the stored revision. */
  get source(): string {
    return this.draft ?? this.open?.latest.source ?? "";
  }

  /** And the tag it is written under, which a Restore can move off the row's own. */
  get language(): ArtifactLanguage | null {
    const open = this.open;
    return this.draftLanguage ?? (open ? effectiveLanguage(open, open.latest) : null);
  }

  get dirty(): boolean {
    return this.draft !== null && this.draft !== this.open?.latest.source;
  }

  /** True once the student's own edit is the newest revision (§13). */
  get editedByStudent(): boolean {
    return this.open?.latest.authoredBy === "student";
  }

  /**
   * Which conversation's list is currently held, and whether one is (§13).
   *
   * A page load and a conversation switch both replace the list wholesale, and
   * neither is a turn landing — so the panel must not open on either. An empty
   * list is not the signal, because a conversation with nothing built yet is
   * exactly where the first artifact appears and that one should open.
   */
  private hydrated = false;
  private hydratedFor: string | null = null;

  /**
   * Replace the list from the server.
   *
   * A draft is dropped only when the artifact it belonged to gained a revision —
   * the model answering again must not silently discard what a pupil was typing,
   * and a reload that returns the same revision must not either.
   *
   * When the model wrote something, the workspace turns to it and follows it:
   * the pupil asked for the thing, and having to go looking for it afterwards
   * was the gap between "it built something" and "they can see it" (§13, §20).
   */
  replace(items: ArtifactView[], conversationId: string | null = null): void {
    const previous = this.open;
    const fresh = !this.hydrated || conversationId !== this.hydratedFor;
    const followed = fresh ? null : followModelWrite(this.items, items);

    this.hydrated = true;
    this.hydratedFor = conversationId;
    // The badge belongs to the list it was raised over. A page load or a switch
    // replaces that list wholesale, so an artifact the pupil never looked at in
    // the conversation they have left must not go on badging the switcher.
    if (fresh) this.unseen = null;
    /**
     * A draft on some *other* artifact is work the pupil is in the middle of,
     * and following the model's write would take the editor out from under them.
     * A draft on the artifact that was just rewritten is a different matter: the
     * revision it was based on is gone, which is the rule below.
     */
    const busyElsewhere = this.dirty && this.openId !== followed;

    this.items = items;

    if (this.openId && !items.some((item) => item.id === this.openId)) {
      this.openId = items[0]?.id ?? null;
      this.resetRun();
      return;
    }

    if (previous && this.open && previous.latest.id !== this.open.latest.id) {
      this.draft = null;
      this.draftLanguage = null;
      this.running = this.open.latest.source;
      this.runningLanguage = effectiveLanguage(this.open, this.open.latest);
      this.outcome = null;
      this.consoleLines = [];
    }

    if (!followed) return;

    // The model wrote something. The pupil asked for it, so the workspace turns
    // to it and — while it stays open — follows the newest thing written.
    if (busyElsewhere) {
      this.unseen = followed;
      return;
    }

    this.show(followed);
    this.reveal();
  }

  /**
   * Put an artifact on screen without changing which surfaces are showing.
   *
   * `select` is the pupil choosing one and always turns to the build surface;
   * this is the workspace following a write, and is also what the transcript's
   * card calls before deciding what to reveal.
   */
  show(artifactId: string): void {
    if (!this.items.some((item) => item.id === artifactId)) return;

    this.openId = artifactId;
    this.tab = "preview";
    this.resetRun();
    this.running = this.open?.latest.source ?? null;
    this.runningLanguage = this.language;
    if (this.unseen === artifactId) this.unseen = null;
  }

  /** Everything about the current run, cleared. */
  private resetRun(): void {
    this.draft = null;
    this.draftLanguage = null;
    this.status = "idle";
    this.error = null;
    this.saveFailed = false;
    this.outcome = null;
    this.consoleLines = [];
    this.running = null;
    this.runningLanguage = null;
  }

  /** What the frame reported, against the source and tag it was actually running (§13). */
  recordOutcome(status: BuildStatus, message: string | null): void {
    this.outcome = {
      source: this.running ?? "",
      language: this.runningLanguage,
      status,
      message,
    };
  }

  /** A batch of printed lines from the artifact. Text, never markup (§13, §21). */
  appendConsole(lines: readonly ConsoleLine[]): void {
    this.consoleLines = [...this.consoleLines, ...lines].slice(-CONSOLE_KEPT);
  }

  /** Fold a stored build result back in, so the report is not sent twice. */
  applyBuildStatus(report: BuildReport): void {
    this.items = this.items.map((item) =>
      item.id === report.artifactId && item.latest.id === report.versionId
        ? {
            ...item,
            latest: { ...item.latest, buildStatus: report.status, buildMessage: report.message },
          }
        : item,
    );
  }

  /**
   * Turn to the build surface (§13).
   *
   * "A prominent Build entry point makes artifact work discoverable rather than
   * an obscure toggle" — so this works with nothing built yet, where the pane
   * says what to ask for rather than the control being absent.
   */
  reveal(stage?: Exclude<WorkspaceStage, "chat">): void {
    // "At least show it": a pupil already reading an artifact fullscreen is not
    // dropped back into the split because the model wrote a second one.
    this.stage = stage ?? (this.stage === "chat" ? "both" : this.stage);

    if (this.openId) {
      if (this.unseen === this.openId) this.unseen = null;
      return;
    }

    // One thing built is the thing they meant; several is a question, and the
    // index is where it is answered rather than by guessing at the first row.
    if (this.items.length === 1) this.show(this.items[0].id);
    else if (this.items.length > 1) this.tab = "index";
  }

  /** Move the workspace to a stage the pupil picked. */
  setStage(stage: WorkspaceStage): void {
    if (stage === "chat") {
      this.stage = "chat";
      return;
    }
    this.reveal(stage);
  }

  /** The keyboard and the transcript card both toggle rather than only opening. */
  toggle(): void {
    if (this.visible) {
      this.stage = "chat";
      return;
    }
    this.reveal();
  }

  /** The pupil choosing an artifact from the index or the transcript. */
  select(artifactId: string | null): void {
    if (artifactId === null) {
      this.openId = null;
      this.resetRun();
      this.tab = "index";
      if (this.stage === "chat") this.stage = "both";
      return;
    }

    this.show(artifactId);
    this.reveal();
  }

  /** Back to the conversation, keeping whatever the frame has built up. */
  hide(): void {
    this.stage = "chat";
  }

  /** A keystroke. Nothing compiles here — that is the point (§13, §20). */
  edit(source: string): void {
    this.draft = source;
  }

  /**
   * Put a stored revision back on screen, under the tag it was written with.
   *
   * Not simply `edit`: an html revision of an artifact since rewritten as a
   * component would otherwise be handed to the Svelte compiler (§13).
   */
  restore(version: ArtifactVersionView): void {
    const open = this.open;
    if (!open) return;

    this.draft = version.source;
    this.draftLanguage = effectiveLanguage(open, version);
  }

  /** A commit point: Run, or the heavily debounced idle behind it (§13). */
  commit(): void {
    // Both, because a restore can bring back a source the artifact already holds
    // under a different tag — same text, different pipeline.
    if (this.source === this.running && this.language === this.runningLanguage) return;

    this.running = this.source;
    this.runningLanguage = this.language;
    this.status = "compiling";
    this.error = null;
    this.outcome = null;
    this.consoleLines = [];
  }

  /** Fold a version the server just stored back into the list. */
  applyVersion(artifactId: string, version: ArtifactVersionView): void {
    this.items = this.items.map((item) =>
      item.id === artifactId ? { ...item, latest: version } : item,
    );

    if (this.openId === artifactId && this.draft === version.source) {
      this.draft = null;
      this.draftLanguage = null;
    }
    this.saveFailed = false;
  }
}
