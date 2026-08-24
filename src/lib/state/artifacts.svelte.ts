import type { ArtifactLanguage, VersionAuthor } from "$lib/artifacts/types";

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
  readonly createdAt: string;
}

export interface ArtifactView {
  readonly id: string;
  readonly language: ArtifactLanguage;
  readonly title: string | null;
  readonly latest: ArtifactVersionView;
}

/** Tabbed by default; split by choice; fullscreen as the primary preview mode (§20). */
export type PanelLayout = "overlay" | "split" | "fullscreen";
export type PanelView = "preview" | "code" | "history";
export type RunStatus = "idle" | "compiling" | "running" | "failed";

export class ArtifactWorkspace {
  items = $state<ArtifactView[]>([]);
  /** Whether the panel is on screen. The Build entry point is what opens it (§13). */
  visible = $state(false);
  openId = $state<string | null>(null);
  layout = $state<PanelLayout>("overlay");
  view = $state<PanelView>("preview");

  /** What the editor holds. Null while the student has not typed anything. */
  draft = $state<string | null>(null);
  /** What the frame is running. Advances only at a commit point (§13). */
  running = $state<string | null>(null);

  status = $state<RunStatus>("idle");
  /** The compiler's or the browser's own words, rendered as text (§13). */
  error = $state<string | null>(null);
  saveFailed = $state(false);

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
    this.items = items;

    if (this.openId && !items.some((item) => item.id === this.openId)) {
      this.openId = items[0]?.id ?? null;
      this.draft = null;
      this.running = null;
      return;
    }

    if (previous && this.open && previous.latest.id !== this.open.latest.id) {
      this.draft = null;
      this.running = this.open.latest.source;
    }
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
    this.running = this.open?.latest.source ?? null;
  }

  close(): void {
    this.visible = false;
    this.draft = null;
    this.running = null;
    this.status = "idle";
    this.error = null;
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
