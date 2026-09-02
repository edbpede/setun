import { type BuildOutcome, type BuildReport, buildReportFor } from "$lib/artifacts/build-report";
import { followModelWrite } from "$lib/artifacts/follow";
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

/** Tabbed by default; split by choice; fullscreen as the primary preview mode (§20). */
export type PanelLayout = "overlay" | "split" | "fullscreen";
export type PanelView = "preview" | "code" | "history";
export type RunStatus = "idle" | "compiling" | "running" | "failed";

/**
 * How many printed lines the panel keeps.
 *
 * A `requestAnimationFrame` loop with a stray `console.log` prints sixty lines a
 * second, and the useful ones are the newest.
 */
const CONSOLE_KEPT = 200;

export class ArtifactWorkspace {
  items = $state<ArtifactView[]>([]);
  /** Whether the panel is on screen. The Build entry point is what opens it (§13). */
  visible = $state(false);
  openId = $state<string | null>(null);
  layout = $state<PanelLayout>("overlay");
  view = $state<PanelView>("preview");

  /**
   * How much of the width the split panel takes (§20).
   *
   * "Split view available by choice… panel handles are draggable by touch." A
   * fixed half is the wrong half about as often as it is the right one on a
   * 1366-pixel screen, so the handle moves it and this holds where it was left.
   */
  splitFraction = $state(0.5);

  /** Clamped so the handle can never drag either side out of existence. */
  setSplitFraction(fraction: number): void {
    this.splitFraction = Math.min(0.8, Math.max(0.25, fraction));
  }

  /** What the editor holds. Null while the student has not typed anything. */
  draft = $state<string | null>(null);
  /** What the frame is running. Advances only at a commit point (§13). */
  running = $state<string | null>(null);

  status = $state<RunStatus>("idle");
  /** The compiler's or the browser's own words, rendered as text (§13). */
  error = $state<string | null>(null);
  saveFailed = $state(false);

  /**
   * How the last run went, and over which source (§13).
   *
   * The source travels with the outcome because a pupil running an unsaved draft
   * is running something no version holds — stamping the stored revision with
   * that result would tell the model a lie about its own code.
   */
  outcome = $state<BuildOutcome | null>(null);

  /** What the artifact printed on this run, oldest first (§13). */
  consoleLines = $state<ConsoleLine[]>([]);

  /**
   * An artifact whose model-written revision the pupil has not looked at.
   *
   * The Build button wears it as a badge, so a pupil whose panel is closed still
   * learns that something was built.
   */
  unseen = $state<string | null>(null);

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

  get dirty(): boolean {
    return this.draft !== null && this.draft !== this.open?.latest.source;
  }

  /** True once the student's own edit is the newest revision (§13). */
  get editedByStudent(): boolean {
    return this.open?.latest.authoredBy === "student";
  }

  /**
   * Replace the list from the server.
   *
   * A draft is dropped only when the artifact it belonged to gained a revision —
   * the model answering again must not silently discard what a pupil was typing,
   * and a reload that returns the same revision must not either.
   */
  replace(items: ArtifactView[]): void {
    const previous = this.open;
    const followed = followModelWrite(this.items, items);
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
      this.draft = null;
      this.running = null;
      this.outcome = null;
      this.consoleLines = [];
      return;
    }

    if (previous && this.open && previous.latest.id !== this.open.latest.id) {
      this.draft = null;
      this.running = this.open.latest.source;
      this.outcome = null;
      this.consoleLines = [];
    }

    if (!followed) return;

    // The model wrote something. The pupil asked for it, so the panel opens on
    // it and — while it stays open — follows the newest thing written (§13, §20).
    if (busyElsewhere) {
      this.unseen = followed;
      return;
    }

    this.visible = true;
    this.show(followed);
  }

  /**
   * Put an artifact on screen without changing whether the panel is open.
   *
   * `select` is the pupil choosing one and always opens the panel; this is the
   * panel following a write, and is also what the transcript's card calls.
   */
  show(artifactId: string): void {
    if (!this.items.some((item) => item.id === artifactId)) return;

    this.openId = artifactId;
    this.draft = null;
    this.status = "idle";
    this.error = null;
    this.saveFailed = false;
    this.outcome = null;
    this.consoleLines = [];
    this.running = this.open?.latest.source ?? null;
    if (this.unseen === artifactId) this.unseen = null;
  }

  /** What the frame reported, against the source it was actually running (§13). */
  recordOutcome(status: BuildStatus, message: string | null): void {
    this.outcome = { source: this.running ?? "", status, message };
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
   * The Build entry point (§13).
   *
   * "A prominent Build entry point makes artifact work discoverable rather than
   * an obscure toggle" — so it opens even with nothing built yet, where the
   * panel says what to ask for rather than the control being absent.
   */
  toggle(): void {
    if (this.visible) {
      this.close();
      return;
    }

    this.visible = true;
    if (!this.openId) this.select(this.items[0]?.id ?? null);
  }

  select(artifactId: string | null): void {
    this.visible = true;
    this.openId = artifactId;
    this.draft = null;
    this.status = "idle";
    this.error = null;
    this.saveFailed = false;
    this.outcome = null;
    this.consoleLines = [];
    this.running = this.open?.latest.source ?? null;
    if (this.unseen === artifactId) this.unseen = null;
  }

  close(): void {
    this.visible = false;
    this.draft = null;
    this.running = null;
    this.status = "idle";
    this.error = null;
    this.outcome = null;
    this.consoleLines = [];
  }

  /** A keystroke. Nothing compiles here — that is the point (§13, §20). */
  edit(source: string): void {
    this.draft = source;
  }

  /** A commit point: Run, or the heavily debounced idle behind it (§13). */
  commit(): void {
    if (this.source === this.running) return;

    this.running = this.source;
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

    if (this.openId === artifactId && this.draft === version.source) this.draft = null;
    this.saveFailed = false;
  }
}
