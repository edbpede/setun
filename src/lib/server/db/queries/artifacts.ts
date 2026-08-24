import { and, desc, eq, inArray, isNull, max, sql } from "drizzle-orm";
import type { ArtifactLanguage, VersionAuthor } from "../../../artifacts/types";
import type { AppDatabase } from "../client";
import { type Artifact, type ArtifactVersion, artifact, artifactVersion } from "../schema";

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
  },
): Artifact {
  return db
    .insert(artifact)
    .values({
      studentId: input.studentId,
      conversationId: input.conversationId ?? null,
      language: input.language,
      title: input.title ?? null,
    })
    .returning()
    .get();
}

/**
 * Append a revision.
 *
 * The revision number is computed from the rows themselves rather than kept as a
 * counter on the artifact: a counter is a second source of truth about the same
 * fact, and the unique index would be the only thing noticing they had diverged.
 */
export function appendArtifactVersion(
  db: AppDatabase,
  input: {
    artifactId: string;
    messageId?: string | null;
    source: string;
    authoredBy: VersionAuthor;
  },
): ArtifactVersion {
  const current =
    db
      .select({ revision: max(artifactVersion.revision) })
      .from(artifactVersion)
      .where(eq(artifactVersion.artifactId, input.artifactId))
      .get()?.revision ?? 0;

  const row = db
    .insert(artifactVersion)
    .values({
      artifactId: input.artifactId,
      messageId: input.messageId ?? null,
      revision: current + 1,
      source: input.source,
      authoredBy: input.authoredBy,
    })
    .returning()
    .get();

  // The gallery and the continuity heuristic both order by recency, and a new
  // revision is what makes an artifact recent.
  db.update(artifact).set({ updatedAt: new Date() }).where(eq(artifact.id, input.artifactId)).run();

  return row;
}

/**
 * The conversation's most recent artifact — the anchor of the continuity
 * heuristic (§13).
 */
export function latestConversationArtifact(
  db: AppDatabase,
  conversationId: string,
): Artifact | undefined {
  return db
    .select()
    .from(artifact)
    .where(eq(artifact.conversationId, conversationId))
    .orderBy(desc(artifact.updatedAt), desc(artifact.createdAt))
    .limit(1)
    .get();
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
