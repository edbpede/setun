import { and, eq, inArray, isNotNull, lt, or } from "drizzle-orm";
import type { AppDatabase } from "../client";
import { artifact, attachment, conversation, generatedImage, session, student } from "../schema";
import { removeConversationFromIndex } from "./search";

/**
 * The reads and writes retention needs (PRD §16, §21).
 *
 * Kept apart from the owner-scoped query modules on purpose: every function here
 * deletes across owners, driven by a classroom policy rather than by a request,
 * and mixing that into modules whose contract is "always scoped to the caller"
 * would blur the invariant those modules exist to hold (§21).
 */

/** A file whose row is about to go, so the bytes can go with it. */
export interface DoomedFile {
  readonly storagePath: string;
}

/** The same, carrying the conversation whose row still names it. */
export interface DoomedAttachment extends DoomedFile {
  readonly conversationId: string;
}

/** Conversations in one classroom last touched before `before`. */
export function expiredConversationIds(
  db: AppDatabase,
  input: { classroomId: string; before: Date },
): string[] {
  return db
    .select({ id: conversation.id })
    .from(conversation)
    .innerJoin(student, eq(student.id, conversation.studentId))
    .where(
      and(eq(student.classroomId, input.classroomId), lt(conversation.updatedAt, input.before)),
    )
    .all()
    .map((row) => row.id);
}

/**
 * Attachment files belonging to a set of conversations, before the rows cascade away.
 *
 * Each file is returned with its conversation so a removal that fails can hold
 * back just that conversation's row rather than the whole batch (§16).
 */
export function attachmentFilesFor(
  db: AppDatabase,
  conversationIds: readonly string[],
): DoomedAttachment[] {
  if (conversationIds.length === 0) return [];

  return (
    db
      .select({ storagePath: attachment.storagePath, conversationId: attachment.conversationId })
      .from(attachment)
      .where(inArray(attachment.conversationId, [...conversationIds]))
      .all()
      // The column is nullable — an upload before its message has no
      // conversation — but the predicate above matched one, so these rows have it.
      .flatMap((row) =>
        row.conversationId === null
          ? []
          : [{ storagePath: row.storagePath, conversationId: row.conversationId }],
      )
  );
}

/**
 * Delete conversations by id.
 *
 * Messages, turns and attachments follow through the schema cascades; artifacts
 * and generated images do not, because their conversation reference is nullable
 * precisely so creations outlive the conversation that produced them (§16).
 */
export function deleteConversations(db: AppDatabase, conversationIds: readonly string[]): number {
  if (conversationIds.length === 0) return 0;

  const deleted = db
    .delete(conversation)
    .where(inArray(conversation.id, [...conversationIds]))
    .returning({ id: conversation.id })
    .all();

  for (const row of deleted) removeConversationFromIndex(db, row.id);

  return deleted.length;
}

/** Creations in one classroom made before `before`, when the classroom sets a period (§16). */
export function expiredCreations(
  db: AppDatabase,
  input: { classroomId: string; before: Date },
): { artifactIds: string[]; images: { id: string; storagePath: string }[] } {
  const artifactIds = db
    .select({ id: artifact.id })
    .from(artifact)
    .innerJoin(student, eq(student.id, artifact.studentId))
    .where(and(eq(student.classroomId, input.classroomId), lt(artifact.updatedAt, input.before)))
    .all()
    .map((row) => row.id);

  const images = db
    .select({ id: generatedImage.id, storagePath: generatedImage.storagePath })
    .from(generatedImage)
    .innerJoin(student, eq(student.id, generatedImage.studentId))
    .where(
      and(eq(student.classroomId, input.classroomId), lt(generatedImage.createdAt, input.before)),
    )
    .all();

  return { artifactIds, images };
}

export function deleteArtifacts(db: AppDatabase, artifactIds: readonly string[]): number {
  if (artifactIds.length === 0) return 0;

  return db
    .delete(artifact)
    .where(inArray(artifact.id, [...artifactIds]))
    .returning({ id: artifact.id })
    .all().length;
}

export function deleteGeneratedImages(db: AppDatabase, imageIds: readonly string[]): number {
  if (imageIds.length === 0) return 0;

  return db
    .delete(generatedImage)
    .where(inArray(generatedImage.id, [...imageIds]))
    .returning({ id: generatedImage.id })
    .all().length;
}

/** Every stored file belonging to one pupil — attachments and generated images (§16, §21). */
export function studentFiles(db: AppDatabase, studentId: string): DoomedFile[] {
  return [
    ...db
      .select({ storagePath: attachment.storagePath })
      .from(attachment)
      .where(eq(attachment.studentId, studentId))
      .all(),
    ...db
      .select({ storagePath: generatedImage.storagePath })
      .from(generatedImage)
      .where(eq(generatedImage.studentId, studentId))
      .all(),
  ];
}

/**
 * Remove session rows that can never authenticate again (§7).
 *
 * Expiry and invalidation are already decided when a session is resolved, so
 * this frees rows rather than enforcing anything — which is why it may run
 * unhurried and why the grace period exists at all: a row deleted the instant it
 * expires makes "your session ended" indistinguishable from "no such session"
 * while support is still looking at it.
 */
export function deleteDeadSessions(db: AppDatabase, before: Date): number {
  return db
    .delete(session)
    .where(
      or(
        lt(session.expiresAt, before),
        and(isNotNull(session.invalidatedAt), lt(session.invalidatedAt, before)),
      ),
    )
    .returning({ id: session.id })
    .all().length;
}
