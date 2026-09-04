import { createHash } from "node:crypto";
import { and, asc, count, desc, eq, inArray, isNull, max, notInArray, sql } from "drizzle-orm";
import { byteLength, type ProjectFiles, type ProjectSnapshot } from "../../../artifacts/project";
import type { ArtifactLanguage, BuildStatus, VersionAuthor } from "../../../artifacts/types";
import type { AppDatabase } from "../client";
import {
  type Artifact,
  type ArtifactVersion,
  artifact,
  artifactBlob,
  artifactVersion,
  artifactVersionFile,
} from "../schema";

/**
 * Artifacts and their revisions (PRD §13, §16, §19).
 *
 * Every read that a student can reach is owner-scoped in SQL: another student's
 * artifact is absent rather than forbidden, so there is nothing to probe (§21).
 * The gallery outlives conversations, so nothing here scopes by conversation
 * unless the caller asks it to (§16).
 */

/** An artifact together with the revision currently on screen. */
export interface ArtifactWithLatest {
  readonly artifact: Artifact;
  readonly latest: ArtifactVersion;
}

/**
 * The join that answers "the current source of each artifact" in one query.
 *
 * Revisions are contiguous and unique per artifact, so the highest revision is
 * the current one and the pairing cannot be ambiguous.
 */
function latestRevisions(db: AppDatabase) {
  return db
    .select({
      artifactId: artifactVersion.artifactId,
      // Named apart from the column it aggregates: SQLite resolves an unqualified
      // `revision` in the join condition against both sides otherwise.
      latestRevision: max(artifactVersion.revision).as("latestRevision"),
    })
    .from(artifactVersion)
    .groupBy(artifactVersion.artifactId)
    .as("latest");
}

function withLatest(db: AppDatabase) {
  const latest = latestRevisions(db);

  return db
    .select({ artifact, latest: artifactVersion })
    .from(artifact)
    .innerJoin(latest, eq(latest.artifactId, artifact.id))
    .innerJoin(
      artifactVersion,
      and(
        eq(artifactVersion.artifactId, artifact.id),
        eq(artifactVersion.revision, latest.latestRevision),
      ),
    );
}

export function createArtifact(
  db: AppDatabase,
  input: {
    studentId: string;
    conversationId?: string | null;
    language: ArtifactLanguage;
    title?: string | null;
    /** The id the model wrote on the fence; null when it wrote none (§13). */
    key?: string | null;
  },
): Artifact {
  return db
    .insert(artifact)
    .values({
      studentId: input.studentId,
      conversationId: input.conversationId ?? null,
      language: input.language,
      key: input.key ?? null,
      title: input.title ?? null,
    })
    .returning()
    .get();
}

/**
 * The identity of a file's content (§13).
 *
 * sha256 hex: a blob is written once however many revisions hold it, and two
 * revisions that share four of five files share four rows. Rows written before
 * the project migration carry a `legacy:` key instead — see `0012`.
 */
export function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** Write one blob if it is not already there, and return its hash. */
export function putBlob(db: AppDatabase, content: string): string {
  const hash = hashContent(content);

  db.insert(artifactBlob)
    .values({ hash, content, bytes: byteLength(content) })
    // Content-addressed, so a second write of the same bytes is the same row.
    .onConflictDoNothing()
    .run();

  return hash;
}

/**
 * Append a revision: a whole snapshot of the project's files (§13).
 *
 * A snapshot, not a diff. A history entry has to be restorable on its own, and a
 * chain of diffs that must be replayed is a history one broken link can lose;
 * the blobs are what make storing every file every time affordable.
 *
 * In a transaction, unlike the single-source append it replaces: it writes three
 * tables, and a revision row whose files never landed is a version that renders
 * nothing and cannot be told from one that legitimately holds no files.
 *
 * The revision number is computed from the rows themselves rather than kept as a
 * counter on the artifact: a counter is a second source of truth about the same
 * fact, and the unique index would be the only thing noticing they had diverged.
 */
export function appendSnapshot(
  db: AppDatabase,
  input: {
    artifactId: string;
    messageId?: string | null;
    authoredBy: VersionAuthor;
    /** The tag it was written under; null for "whatever the artifact says" (§13). */
    language?: ArtifactLanguage | null;
    entry: string;
    files: ProjectFiles;
  },
): ArtifactVersion {
  return db.transaction((tx) => {
    const current =
      tx
        .select({ revision: max(artifactVersion.revision) })
        .from(artifactVersion)
        .where(eq(artifactVersion.artifactId, input.artifactId))
        .get()?.revision ?? 0;

    const row = tx
      .insert(artifactVersion)
      .values({
        artifactId: input.artifactId,
        messageId: input.messageId ?? null,
        revision: current + 1,
        entryPath: input.entry,
        language: input.language ?? null,
        authoredBy: input.authoredBy,
      })
      .returning()
      .get();

    for (const [path, content] of Object.entries(input.files)) {
      const hash = hashContent(content);

      tx.insert(artifactBlob)
        .values({ hash, content, bytes: byteLength(content) })
        .onConflictDoNothing()
        .run();

      tx.insert(artifactVersionFile).values({ versionId: row.id, path, blobHash: hash }).run();
    }

    // The gallery and the continuity heuristic both order by recency, and a new
    // revision is what makes an artifact recent.
    tx.update(artifact)
      .set({ updatedAt: new Date() })
      .where(eq(artifact.id, input.artifactId))
      .run();

    return row;
  });
}

/** One revision's files, content and all — what the sandbox is handed (§13). */
export function snapshotOf(db: AppDatabase, versionId: string): ProjectSnapshot | null {
  const version = db
    .select({ entryPath: artifactVersion.entryPath })
    .from(artifactVersion)
    .where(eq(artifactVersion.id, versionId))
    .get();
  if (!version) return null;

  const rows = db
    .select({ path: artifactVersionFile.path, content: artifactBlob.content })
    .from(artifactVersionFile)
    .innerJoin(artifactBlob, eq(artifactBlob.hash, artifactVersionFile.blobHash))
    .where(eq(artifactVersionFile.versionId, versionId))
    .orderBy(asc(artifactVersionFile.path))
    .all();

  const files: Record<string, string> = Object.create(null);
  for (const row of rows) files[row.path] = row.content;

  return { entry: version.entryPath, files };
}

/**
 * The snapshots of many revisions at once (§13).
 *
 * One query rather than one per artifact: a conversation's page data carries the
 * current project of everything the pupil has built, and a lesson with a dozen
 * creations would otherwise be a dozen round trips per load.
 */
export function snapshotsOf(
  db: AppDatabase,
  versionIds: readonly string[],
): Map<string, ProjectSnapshot> {
  const snapshots = new Map<string, ProjectSnapshot>();
  if (versionIds.length === 0) return snapshots;

  const versions = db
    .select({ id: artifactVersion.id, entryPath: artifactVersion.entryPath })
    .from(artifactVersion)
    .where(inArray(artifactVersion.id, [...versionIds]))
    .all();

  for (const version of versions) {
    snapshots.set(version.id, { entry: version.entryPath, files: Object.create(null) });
  }

  const rows = db
    .select({
      versionId: artifactVersionFile.versionId,
      path: artifactVersionFile.path,
      content: artifactBlob.content,
    })
    .from(artifactVersionFile)
    .innerJoin(artifactBlob, eq(artifactBlob.hash, artifactVersionFile.blobHash))
    .where(inArray(artifactVersionFile.versionId, [...versionIds]))
    .orderBy(asc(artifactVersionFile.versionId), asc(artifactVersionFile.path))
    .all();

  for (const row of rows) {
    const snapshot = snapshots.get(row.versionId);
    // The files map is a null-prototype record, so a path called `__proto__` is
    // a path rather than a way to reach `Object` (§21).
    if (snapshot) (snapshot.files as Record<string, string>)[row.path] = row.content;
  }

  return snapshots;
}

/** The newest revision's project, for an artifact about to gain another (§13). */
export function latestSnapshotOf(db: AppDatabase, artifactId: string): ProjectSnapshot | null {
  const version = db
    .select({ id: artifactVersion.id })
    .from(artifactVersion)
    .where(eq(artifactVersion.artifactId, artifactId))
    .orderBy(desc(artifactVersion.revision))
    .limit(1)
    .get();

  return version ? snapshotOf(db, version.id) : null;
}

/**
 * Pair each artifact with the current source of its entry file (§13).
 *
 * The one place the several readers that still want "the source" go through, so
 * a project's entry is resolved once rather than in each page's own map — and so
 * the day those readers want the whole file list, there is one call to change.
 */
export function attachSnapshots(
  db: AppDatabase,
  rows: readonly ArtifactWithLatest[],
): (ArtifactWithLatest & { readonly source: string; readonly snapshot: ProjectSnapshot })[] {
  const snapshots = snapshotsOf(
    db,
    rows.map((row) => row.latest.id),
  );

  return rows.map((row) => {
    const snapshot = snapshots.get(row.latest.id) ?? {
      entry: row.latest.entryPath,
      files: Object.create(null),
    };

    return { ...row, snapshot, source: snapshot.files[row.latest.entryPath] ?? "" };
  });
}

/** What one revision holds, without its content — the history view's rows (§13). */
export interface VersionFileRow {
  readonly versionId: string;
  readonly path: string;
  readonly hash: string;
  readonly bytes: number;
}

export function listVersionFiles(db: AppDatabase, versionIds: readonly string[]): VersionFileRow[] {
  if (versionIds.length === 0) return [];

  return db
    .select({
      versionId: artifactVersionFile.versionId,
      path: artifactVersionFile.path,
      hash: artifactVersionFile.blobHash,
      bytes: artifactBlob.bytes,
    })
    .from(artifactVersionFile)
    .innerJoin(artifactBlob, eq(artifactBlob.hash, artifactVersionFile.blobHash))
    .where(inArray(artifactVersionFile.versionId, [...versionIds]))
    .orderBy(asc(artifactVersionFile.versionId), asc(artifactVersionFile.path))
    .all();
}

/**
 * Blobs no revision holds any more, removed (§16).
 *
 * A blob is shared, so it cannot cascade from the revision that happened to be
 * deleted — taking it would take it from every other revision holding it. This
 * sweeps instead, after a deletion, which is the only moment one can be orphaned.
 */
export function pruneOrphanBlobs(db: AppDatabase): number {
  const held = db.select({ hash: artifactVersionFile.blobHash }).from(artifactVersionFile);

  const removed = db
    .delete(artifactBlob)
    .where(notInArray(artifactBlob.hash, held))
    .returning({ hash: artifactBlob.hash })
    .all();

  return removed.length;
}

/**
 * What continuity resolves over: each artifact's identity and when it was last
 * written (§13).
 *
 * `updatedAt` is milliseconds, and two artifacts rewritten in one message tie on
 * it — so the anchor also carries the `rowid` of the artifact's newest version.
 * That is SQLite's own insertion counter, so it is the write order `updatedAt`
 * cannot express, and it moves only when a revision lands: renaming an artifact
 * touches `updatedAt` and is not a write of the thing itself.
 */
export interface ArtifactAnchorRow {
  readonly id: string;
  readonly language: ArtifactLanguage;
  readonly key: string | null;
  readonly updatedAt: Date;
  readonly writtenAt: number;
}

export function listConversationAnchors(
  db: AppDatabase,
  input: { conversationId: string; studentId: string },
): ArtifactAnchorRow[] {
  return db
    .select({
      id: artifact.id,
      language: artifact.language,
      key: artifact.key,
      updatedAt: artifact.updatedAt,
      writtenAt: sql<number>`max("artifact_version"."rowid")`,
    })
    .from(artifact)
    .innerJoin(artifactVersion, eq(artifactVersion.artifactId, artifact.id))
    .where(
      and(
        eq(artifact.conversationId, input.conversationId),
        eq(artifact.studentId, input.studentId),
      ),
    )
    .groupBy(artifact.id)
    .all();
}

/** Persist the key a model adopted, so the next turn resolves to this row (§13). */
export function setArtifactKey(db: AppDatabase, input: { artifactId: string; key: string }): void {
  db.update(artifact).set({ key: input.key }).where(eq(artifact.id, input.artifactId)).run();
}

/**
 * A rewrite under the same id changed the language (§13).
 *
 * The key is the identity, not the tag: a page reworked as a Svelte component is
 * one thing to the pupil, so the row follows rather than forking.
 */
export function setArtifactLanguage(
  db: AppDatabase,
  input: { artifactId: string; language: ArtifactLanguage },
): void {
  db.update(artifact)
    .set({ language: input.language })
    .where(eq(artifact.id, input.artifactId))
    .run();
}

/** One artifact, for its owner. Absent for anyone else (§21). */
export function getOwnedArtifact(
  db: AppDatabase,
  input: { artifactId: string; studentId: string },
): Artifact | undefined {
  return db
    .select()
    .from(artifact)
    .where(and(eq(artifact.id, input.artifactId), eq(artifact.studentId, input.studentId)))
    .get();
}

/** Every revision, oldest first — the history the diff view reads (§13). */
export function listArtifactVersions(db: AppDatabase, artifactId: string): ArtifactVersion[] {
  return db
    .select()
    .from(artifactVersion)
    .where(eq(artifactVersion.artifactId, artifactId))
    .orderBy(artifactVersion.revision)
    .all();
}

/** The artifacts of one conversation, newest first, each with its current source. */
export function listConversationArtifacts(
  db: AppDatabase,
  input: { conversationId: string; studentId: string },
): ArtifactWithLatest[] {
  return withLatest(db)
    .where(
      and(
        eq(artifact.conversationId, input.conversationId),
        eq(artifact.studentId, input.studentId),
      ),
    )
    .orderBy(desc(artifact.updatedAt))
    .all();
}

/** The student's own gallery, newest first (§13, §16). */
export function listStudentArtifacts(db: AppDatabase, studentId: string): ArtifactWithLatest[] {
  return withLatest(db)
    .where(eq(artifact.studentId, studentId))
    .orderBy(desc(artifact.updatedAt))
    .all();
}

/**
 * Artifacts this conversation has whose newest revision is the student's own and
 * has not yet travelled to the model (§13).
 */
export function undeliveredStudentEdits(
  db: AppDatabase,
  input: { conversationId: string; studentId: string },
): ArtifactWithLatest[] {
  return withLatest(db)
    .where(
      and(
        eq(artifact.conversationId, input.conversationId),
        eq(artifact.studentId, input.studentId),
        eq(artifactVersion.authoredBy, "student"),
        isNull(artifactVersion.deliveredAt),
      ),
    )
    .orderBy(desc(artifact.updatedAt))
    .all();
}

/** Records that a revision has been carried to the model, so it is not sent twice (§13). */
export function markVersionsDelivered(db: AppDatabase, versionIds: readonly string[]): void {
  if (versionIds.length === 0) return;

  db.update(artifactVersion)
    .set({ deliveredAt: new Date() })
    .where(inArray(artifactVersion.id, [...versionIds]))
    .run();
}

/**
 * Every version of every artifact in one conversation, in one query (§13).
 *
 * The prompt needs two things from the same rows — which message holds the
 * current source of each artifact, so superseded copies can be elided, and each
 * artifact's revision count and last run result for the state note — and asking
 * per artifact would be one query per thing the pupil has built.
 *
 * Ordered by artifact and then revision, so a caller folds it in one pass — the
 * last row of each group being that artifact's current source. The identifier
 * joins the sort because `createdAt` is milliseconds: two artifacts created in
 * one message tie on it, and the groups would otherwise interleave.
 */
export function listConversationVersions(
  db: AppDatabase,
  input: { conversationId: string; studentId: string },
): { artifact: Artifact; version: ArtifactVersion }[] {
  return db
    .select({ artifact, version: artifactVersion })
    .from(artifact)
    .innerJoin(artifactVersion, eq(artifactVersion.artifactId, artifact.id))
    .where(
      and(
        eq(artifact.conversationId, input.conversationId),
        eq(artifact.studentId, input.studentId),
      ),
    )
    .orderBy(asc(artifact.createdAt), asc(artifact.id), asc(artifactVersion.revision))
    .all();
}

/**
 * Every version recorded against a message, for the transcript's cards (§13).
 *
 * In recording order, which is what the transcript aligns its cards against: a
 * message that rewrites one artifact and creates another holds a fifth revision
 * and a first, and ordering by revision would put them back to front — the card
 * under each block would name the other block's artifact.
 *
 * Recording order is insertion order, and `createdAt` is only milliseconds, so
 * SQLite's own `rowid` breaks the ties that two blocks of one message produce.
 */
export function versionsByMessage(
  db: AppDatabase,
  messageIds: readonly string[],
): { artifact: Artifact; version: ArtifactVersion }[] {
  if (messageIds.length === 0) return [];

  return db
    .select({ artifact, version: artifactVersion })
    .from(artifactVersion)
    .innerJoin(artifact, eq(artifact.id, artifactVersion.artifactId))
    .where(inArray(artifactVersion.messageId, [...messageIds]))
    .orderBy(asc(artifactVersion.createdAt), sql`"artifact_version"."rowid"`)
    .all();
}

/**
 * What happened when the browser ran this revision (§13).
 *
 * Owner-scoped in the statement itself, so a request naming somebody else's
 * artifact writes nothing and reports nothing (§21). It deliberately does *not*
 * bump `updatedAt`: running an artifact is not editing it, and the panel's
 * follow rule and the gallery's ordering both read recency as "last written".
 */
export function recordVersionBuild(
  db: AppDatabase,
  input: {
    artifactId: string;
    versionId: string;
    studentId: string;
    status: BuildStatus;
    message: string | null;
  },
): boolean {
  const owned = getOwnedArtifact(db, {
    artifactId: input.artifactId,
    studentId: input.studentId,
  });
  if (!owned) return false;

  const updated = db
    .update(artifactVersion)
    .set({ buildStatus: input.status, buildMessage: input.message })
    .where(and(eq(artifactVersion.id, input.versionId), eq(artifactVersion.artifactId, owned.id)))
    .returning({ id: artifactVersion.id })
    .all();

  return updated.length > 0;
}

export function setArtifactTitle(
  db: AppDatabase,
  input: { artifactId: string; title: string },
): void {
  db.update(artifact).set({ title: input.title }).where(eq(artifact.id, input.artifactId)).run();
}

/**
 * The student deleting their own creation (§16).
 *
 * Owner-scoped in the statement itself, so a request naming somebody else's
 * artifact deletes nothing and reports nothing.
 */
export function deleteOwnedArtifact(
  db: AppDatabase,
  input: { artifactId: string; studentId: string },
): boolean {
  const deleted = db
    .delete(artifact)
    .where(and(eq(artifact.id, input.artifactId), eq(artifact.studentId, input.studentId)))
    .returning({ id: artifact.id })
    .all();

  return deleted.length > 0;
}

/** Count of an artifact's revisions, for the gallery's summary line. */
export function countArtifactVersions(db: AppDatabase, artifactId: string): number {
  return (
    db
      .select({ count: sql<number>`count(*)` })
      .from(artifactVersion)
      .where(eq(artifactVersion.artifactId, artifactId))
      .get()?.count ?? 0
  );
}

/**
 * How many creations a set of pupils holds between them.
 *
 * A count, for the confirmation that precedes deleting a classroom (§16).
 */
export function countArtifacts(db: AppDatabase, studentIds: readonly string[]): number {
  if (studentIds.length === 0) return 0;

  return (
    db
      .select({ total: count() })
      .from(artifact)
      .where(inArray(artifact.studentId, [...studentIds]))
      .get()?.total ?? 0
  );
}
