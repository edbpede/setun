import { continuityDecision } from "../../artifacts/continuity";
import { detectArtifacts } from "../../artifacts/detect";
import { artifactTitle } from "../../artifacts/document";
import type { ArtifactLanguage } from "../../artifacts/types";
import type { AppDatabase } from "../db/client";
import {
  type ArtifactWithLatest,
  appendArtifactVersion,
  createArtifact,
  latestConversationArtifact,
  listConversationArtifacts,
  markVersionsDelivered,
  setArtifactTitle,
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
}

/**
 * Record every artifact block in an assistant message.
 *
 * Continuity is resolved block by block against the conversation's most recent
 * artifact, which the previous block may just have become — the heuristic reads
 * "the conversation's most recent artifact", and a message emitting two HTML
 * blocks is two revisions of one thing under that rule (§13).
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

  for (const detected of detectArtifacts(prose)) {
    const latest = latestConversationArtifact(db, input.conversationId);
    const decision = continuityDecision({
      language: detected.language,
      latest: latest ? { id: latest.id, language: latest.language } : null,
    });

    const artifactId =
      decision.kind === "version"
        ? decision.artifactId
        : createArtifact(db, {
            studentId: input.studentId,
            conversationId: input.conversationId,
            language: detected.language,
            title: artifactTitle(detected.source),
          }).id;

    const version = appendArtifactVersion(db, {
      artifactId,
      messageId: input.messageId,
      source: detected.source,
      authoredBy: "model",
    });

    // A later revision may name the thing the first one left unnamed.
    if (decision.kind === "version" && latest && !latest.title) {
      const title = artifactTitle(detected.source);
      if (title) setArtifactTitle(db, { artifactId, title });
    }

    recorded.push({ artifactId, versionId: version.id, language: detected.language });
  }

  return recorded;
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
  return undeliveredStudentEdits(db, input).map(toEditPart);
}

function toEditPart({
  artifact,
  latest,
}: ArtifactWithLatest): Extract<MessagePart, { type: "artifact-edit" }> {
  return {
    type: "artifact-edit",
    artifactId: artifact.id,
    versionId: latest.id,
    language: artifact.language,
    title: artifact.title,
    source: latest.source,
  };
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

  return [...pending, ...carried.map(toEditPart)];
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
