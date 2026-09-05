import { continuityDecision } from "../../artifacts/continuity";
import { detectArtifacts, groupProjectWrites, type ProjectWrite } from "../../artifacts/detect";
import { artifactTitle } from "../../artifacts/document";
import { effectiveArtifactKey, effectiveLanguage } from "../../artifacts/identity";
import {
  asProjectFiles,
  defaultPathFor,
  diffFileLists,
  entryOf,
  type FileChange,
  type ProjectFiles,
  type ProjectSnapshot,
  runnableLanguageOf,
  sameFiles,
} from "../../artifacts/project";
import type { ArtifactLanguage } from "../../artifacts/types";
import type { AppDatabase } from "../db/client";
import {
  type ArtifactWithLatest,
  appendSnapshot,
  createArtifact,
  listArtifactVersions,
  listConversationAnchors,
  listConversationArtifacts,
  markVersionsDelivered,
  setArtifactKey,
  setArtifactLanguage,
  setArtifactTitle,
  snapshotOf,
  undeliveredStudentEdits,
} from "../db/queries/artifacts";
import { getMessage } from "../db/queries/messages";
import type { MessagePart } from "../db/schema";

/**
 * Artifacts out of a finished turn (PRD §13, §19).
 *
 * Detection is the renderer's rule (`$lib/artifacts/detect`), applied here so
 * the creation is *recorded* the moment the model writes it: creations outlive
 * their conversations, and one that existed only in a rendered message would
 * disappear when that conversation expired (§16).
 *
 * Runs beside `image-generation`, on the same side of the boundary and for the
 * same reason — both turn something a turn produced into a row the gallery owns.
 */

export interface RecordedArtifact {
  readonly artifactId: string;
  readonly versionId: string;
  readonly language: ArtifactLanguage;
  /** The id the artifact answers to, written or derived (§13). */
  readonly key: string;
  /** True when the write was identical to what the artifact already held. */
  readonly unchanged: boolean;
  /** How many files the project now holds, for the transcript's card (§13). */
  readonly fileCount: number;
  /** What this revision did to each file, for the card's summary. */
  readonly changes: readonly FileChange[];
}

/**
 * The project one write leaves behind, or null when it leaves nothing runnable.
 *
 * Pure, and separate from the recording around it: what a set of fences means
 * for a project is a question about files, and answering it against a database
 * is what made the single-source version untestable without one.
 *
 * A keyed write is a *change* to the project, not a replacement of it: files the
 * model did not mention are kept. That is the whole economy of the thing — a
 * pupil asking for a different colour gets one `css` fence back instead of a
 * thousand-line page. A key-less block keeps the old meaning: one file, one
 * artifact, replacing whatever was there.
 */
export interface ComposedSnapshot {
  readonly entry: string;
  readonly files: ProjectFiles;
  readonly language: ArtifactLanguage;
}

export function composeSnapshot(
  previous: ProjectSnapshot | null,
  write: ProjectWrite,
): ComposedSnapshot | null {
  if (write.single) {
    // The pre-project shape, unchanged: a fence with no id is one file that
    // stands for the whole artifact.
    const language = write.single.language;
    if (!language) return null;

    const path = defaultPathFor(language);
    const files = asProjectFiles({ [path]: write.single.source });
    if (!files) return null;
    return { entry: path, files, language };
  }

  const files: Record<string, string> = { ...(previous?.files ?? {}) };

  /**
   * A keyed fence with no `path=`.
   *
   * Almost always the entry written the old way. It lands on the project's
   * current entry when the tag still matches what runs there, and at that tag's
   * conventional path otherwise — which is how a page rewritten as a component
   * under the same id moves from `index.html` to `App.svelte`.
   */
  let moved: string | null = null;

  for (const block of write.pathless) {
    if (!block.language) continue;

    if (previous && runnableLanguageOf(previous.entry) === block.language) {
      files[previous.entry] = block.source;
      continue;
    }

    /**
     * The tag changed: a page rewritten as a component under the same id.
     *
     * One thing to the pupil, so the row follows — and the file it used to run
     * goes, because it *is* what was rewritten. Leaving `index.html` beside the
     * new `App.svelte` would keep the old page as the project's entry and the
     * rewrite would do nothing at all.
     */
    const path = defaultPathFor(block.language);
    if (previous && previous.entry !== path) delete files[previous.entry];
    files[path] = block.source;
    moved = path;
  }

  for (const [path, source] of Object.entries(write.files)) files[path] = source;

  for (const path of write.deletes) {
    const remaining = { ...files };
    delete remaining[path];
    // A deletion that would leave the project with nothing to render is not a
    // deletion the pupil meant; the file stays and the model is told nothing.
    if (entryOf(remaining) === null) continue;
    delete files[path];
  }

  const checked = asProjectFiles(files);
  if (!checked) return null;

  const entry = entryOf(checked, {
    explicit: write.entryHint ?? moved,
    previous: previous?.entry,
    writtenOrder: write.writtenOrder,
  });
  if (!entry) return null;

  const language = runnableLanguageOf(entry);
  if (!language) return null;

  return { entry, files: checked, language };
}

/**
 * Record every artifact block in an assistant message.
 *
 * Continuity is resolved write by write, against the conversation as it stands
 * *after* the previous write — a message that writes two blocks under one id is
 * one revision of one thing, and under two ids it is two things (§13).
 *
 * Three rules beyond the resolution itself:
 *
 * - A key the model wrote is persisted onto the row it resolved to, including
 *   the fallback key the state note offered it. Adopting the id it was shown is
 *   how a model that started without one settles onto a name.
 * - The language follows the key. A page rewritten as a component under the same
 *   id is one thing to the pupil, so the row changes tag rather than forking —
 *   and the revision records the tag *it* was written under, so restoring an
 *   older one later does not run it through the new pipeline.
 * - An identical re-emission appends no revision. Models restate a file they did
 *   not change, and a history of eight identical revisions is a history of
 *   nothing — while every real change is still retained, which is what §13 asks.
 *   Identical means the files *and* the tag: the same project re-emitted under a
 *   new language is a different thing to run, and the revision carries it.
 */
export function recordTurnArtifacts(
  db: AppDatabase,
  input: {
    studentId: string;
    conversationId: string;
    messageId: string;
    parts: readonly MessagePart[];
  },
): RecordedArtifact[] {
  const prose = input.parts
    .filter((part): part is Extract<MessagePart, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n");

  const recorded: RecordedArtifact[] = [];

  for (const write of groupProjectWrites(detectArtifacts(prose))) {
    /**
     * The language this write resolves continuity on.
     *
     * The entry's, where the write states one; otherwise whatever the previous
     * revision runs, which is the css-only case — a write that changes nothing
     * but a stylesheet still belongs to the artifact its `id=` names, and
     * `continuityDecision` resolves a written key across languages, so the
     * value here only matters for a key-less block (§13).
     */
    const written = firstLanguageOf(write);

    // Re-read per write: an earlier write may have created the row this one
    // resolves to, or given it the key this one names.
    const rows = listConversationArtifacts(db, {
      conversationId: input.conversationId,
      studentId: input.studentId,
    });

    const decision = continuityDecision({
      language: written ?? "html",
      key: write.key,
      // Read apart from `rows`: the anchors carry the write order that decides
      // a tie, which `updatedAt` alone cannot express (§13).
      existing: listConversationAnchors(db, {
        conversationId: input.conversationId,
        studentId: input.studentId,
      }).map((anchor) => ({
        id: anchor.id,
        language: anchor.language,
        key: anchor.key,
        updatedAt: anchor.updatedAt.getTime(),
        writtenAt: anchor.writtenAt,
      })),
    });

    const existing =
      decision.kind === "version"
        ? rows.find(({ artifact }) => artifact.id === decision.artifactId)
        : undefined;
    const previous = existing ? snapshotOf(db, existing.latest.id) : null;

    const composed = composeSnapshot(previous, write);
    // Nothing runnable, or over the caps: recorded as nothing at all, and the
    // block renders in the transcript as the fence the model wrote (§13).
    if (!composed) continue;

    const title = write.title ?? artifactTitle(sourceForTitle(composed));

    if (!existing) {
      const created = createArtifact(db, {
        studentId: input.studentId,
        conversationId: input.conversationId,
        language: composed.language,
        key: decision.kind === "new" ? decision.key : null,
        title,
      });

      const version = appendSnapshot(db, {
        artifactId: created.id,
        messageId: input.messageId,
        entry: composed.entry,
        files: composed.files,
        language: composed.language,
        authoredBy: "model",
      });

      recorded.push({
        artifactId: created.id,
        versionId: version.id,
        language: composed.language,
        key: effectiveArtifactKey(created),
        unchanged: false,
        fileCount: Object.keys(composed.files).length,
        changes: changesBetween(null, composed.files),
      });
      continue;
    }

    if (write.key && existing.artifact.key !== write.key) {
      setArtifactKey(db, { artifactId: existing.artifact.id, key: write.key });
    }
    if (existing.artifact.language !== composed.language) {
      setArtifactLanguage(db, {
        artifactId: existing.artifact.id,
        language: composed.language,
      });
    }

    // An explicit `title=` renames; a title read out of the source only names
    // what is still unnamed, so a later revision cannot quietly retitle the
    // thing a pupil has been calling something else.
    const rename = write.title ?? (existing.artifact.title ? null : title);
    if (rename) setArtifactTitle(db, { artifactId: existing.artifact.id, title: rename });

    const key = effectiveArtifactKey({
      language: composed.language,
      id: existing.artifact.id,
      key: write.key ?? existing.artifact.key,
    });

    // Both, for the same reason a commit point in the panel compares both: the
    // same files under a new tag are a different pipeline, and leaving it on the
    // old revision would tag the row `svelte` while its current version still
    // says `html` — which is the tag anything running it resolves through (§13).
    if (
      previous !== null &&
      previous.entry === composed.entry &&
      sameFiles(previous.files, composed.files) &&
      effectiveLanguage(existing.artifact, existing.latest) === composed.language
    ) {
      recorded.push({
        artifactId: existing.artifact.id,
        versionId: existing.latest.id,
        language: composed.language,
        key,
        unchanged: true,
        fileCount: Object.keys(composed.files).length,
        changes: [],
      });
      continue;
    }

    const version = appendSnapshot(db, {
      artifactId: existing.artifact.id,
      messageId: input.messageId,
      entry: composed.entry,
      files: composed.files,
      language: composed.language,
      authoredBy: "model",
    });

    recorded.push({
      artifactId: existing.artifact.id,
      versionId: version.id,
      language: composed.language,
      key,
      unchanged: false,
      fileCount: Object.keys(composed.files).length,
      changes: changesBetween(previous?.files ?? null, composed.files),
    });
  }

  return recorded;
}

/** The first runnable tag this write states, for a key-less continuity guess. */
function firstLanguageOf(write: ProjectWrite): ArtifactLanguage | null {
  if (write.single) return write.single.language;

  for (const block of write.blocks) {
    if (block.language) return block.language;
  }
  return null;
}

/** The entry's source, which is where a title is read from when one is needed. */
function sourceForTitle(composed: ComposedSnapshot): string {
  return composed.files[composed.entry] ?? "";
}

/** What a revision did to each file, by content rather than by hash. */
function changesBetween(previous: ProjectFiles | null, next: ProjectFiles): FileChange[] {
  const refs = (files: ProjectFiles | null) =>
    Object.entries(files ?? {}).map(([path, source]) => ({ path, hash: source }));

  return diffFileLists(refs(previous), refs(next)).filter(
    (change) => change.change !== "unchanged",
  );
}

/**
 * The student's unsent edits, as parts of the message about to be sent (§13).
 *
 * "So 'I broke it, help me fix it' works without pasting code by hand." Only
 * edits the model has not already been shown: the *next* message carries the
 * current source, not every message forever.
 */
export function pendingArtifactEditParts(
  db: AppDatabase,
  input: { conversationId: string; studentId: string },
): Extract<MessagePart, { type: "artifact-edit" }>[] {
  return undeliveredStudentEdits(db, input).map((row) => toEditPart(db, row));
}

function toEditPart(
  db: AppDatabase,
  { artifact, latest }: ArtifactWithLatest,
): Extract<MessagePart, { type: "artifact-edit" }> {
  const current = snapshotOf(db, latest.id) ?? { entry: latest.entryPath, files: {} };

  /**
   * Only what the student changed since the model last wrote (§13).
   *
   * A project of ten files edited in one place travels as one fence. The
   * baseline is the newest revision the *model* wrote: everything after it is
   * the pupil's, however many times they saved.
   */
  const baseline = newestModelSnapshot(db, artifact.id, latest.id);
  const changes = diffFileLists(
    Object.entries(baseline?.files ?? {}).map(([path, source]) => ({ path, hash: source })),
    Object.entries(current.files).map(([path, source]) => ({ path, hash: source })),
  );

  const files: Record<string, string> = {};
  const deleted: string[] = [];
  for (const change of changes) {
    if (change.change === "deleted") deleted.push(change.path);
    else if (change.change !== "unchanged") files[change.path] = current.files[change.path];
  }

  return {
    type: "artifact-edit",
    artifactId: artifact.id,
    versionId: latest.id,
    // The tag *this* revision was written under: an artifact since rewritten as
    // a component still carries the pupil's html edit as html (§13).
    language: effectiveLanguage(artifact, latest),
    title: artifact.title,
    source: current.files[current.entry] ?? "",
    entry: current.entry,
    // Everything, where nothing distinguishes the pupil's edit from the whole
    // project — a first revision they wrote themselves, or one with no model
    // revision behind it at all.
    files: baseline ? files : { ...current.files },
    deleted,
    // The id the model must reuse to change it — the same identity it writes on
    // its own blocks, so the carried source is something it can answer in kind.
    key: effectiveArtifactKey(artifact),
  };
}

/** The newest revision the model wrote, below `belowId`; null when there is none. */
function newestModelSnapshot(
  db: AppDatabase,
  artifactId: string,
  belowId: string,
): ProjectSnapshot | null {
  const versions = listArtifactVersions(db, artifactId);
  const at = versions.findIndex((version) => version.id === belowId);
  const earlier = at === -1 ? versions : versions.slice(0, at);

  const model = earlier.findLast((version) => version.authoredBy === "model");
  return model ? snapshotOf(db, model.id) : null;
}

/**
 * The edits the message about to be sent should carry (§13).
 *
 * Editing a prompt appends a sibling, and a sibling excludes the message it
 * replaces from the model's path — so an edit that travelled with the original
 * reaches the model on no branch at all unless the replacement carries it
 * again. The stamp records that a revision was delivered, not which branch it
 * was delivered on, which is why a retry cannot rely on it.
 *
 * What is re-carried is the artifact as it stands now, never the snapshot the
 * replaced message held: the block tells the model it is looking at the current
 * source, and a revision made after that message would make that untrue. So the
 * replaced message names *which* artifacts to carry, and the artifact itself
 * supplies the source.
 */
export function outgoingArtifactEditParts(
  db: AppDatabase,
  input: { conversationId: string; studentId: string; editOfMessageId?: string },
): Extract<MessagePart, { type: "artifact-edit" }>[] {
  const pending = pendingArtifactEditParts(db, input);
  if (!input.editOfMessageId) return pending;

  // Scoped to the conversation the caller already resolved as this student's,
  // exactly as `appendSibling` scopes the same identifier (§21).
  const original = getMessage(db, input.editOfMessageId);
  if (!original || original.conversationId !== input.conversationId) return pending;

  const named = new Set(
    original.parts.flatMap((part) => (part.type === "artifact-edit" ? [part.artifactId] : [])),
  );
  for (const part of pending) named.delete(part.artifactId);
  if (named.size === 0) return pending;

  const carried = listConversationArtifacts(db, input).filter(
    // A revision the model wrote since is not the student's to re-present as
    // theirs; their next edit of it travels as an ordinary pending one.
    ({ artifact, latest }) => named.has(artifact.id) && latest.authoredBy === "student",
  );

  return [...pending, ...carried.map((row) => toEditPart(db, row))];
}

/** Marks those edits as carried, so the following message does not repeat them (§13). */
export function markArtifactEditsDelivered(
  db: AppDatabase,
  parts: readonly Extract<MessagePart, { type: "artifact-edit" }>[],
): void {
  markVersionsDelivered(
    db,
    parts.map((part) => part.versionId),
  );
}
