import { continuityDecision } from "../../artifacts/continuity";
import { detectArtifacts } from "../../artifacts/detect";
import { artifactTitle } from "../../artifacts/document";
import { effectiveArtifactKey } from "../../artifacts/identity";
import type { ArtifactLanguage } from "../../artifacts/types";
import type { AppDatabase } from "../db/client";
import {
  type ArtifactWithLatest,
  appendArtifactVersion,
  createArtifact,
  listConversationArtifacts,
  markVersionsDelivered,
  setArtifactKey,
  setArtifactLanguage,
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
  /** The id the artifact answers to, written or derived (§13). */
  readonly key: string;
  /** True when the block was identical to what the artifact already held. */
  readonly unchanged: boolean;
}

/**
 * Record every artifact block in an assistant message.
 *
 * Continuity is resolved block by block, against the conversation as it stands
 * *after* the previous block — a message that writes two blocks under one id is
 * two revisions of one thing, and under two ids it is two things (§13).
 *
 * Three rules beyond the resolution itself:
 *
 * - A key the model wrote is persisted onto the row it resolved to, including
 *   the fallback key the state note offered it. Adopting the id it was shown is
 *   how a model that started without one settles onto a name.
 * - The language follows the key. A page rewritten as a component under the same
 *   id is one thing to the pupil, so the row changes tag rather than forking.
 * - An identical re-emission appends no revision. Models restate a file they did
 *   not change, and a history of eight identical revisions is a history of
 *   nothing — while every real change is still retained, which is what §13 asks.
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
    // Re-read per block: the previous block may have created the row this one
    // resolves to, or given it the key this one names.
    const rows = listConversationArtifacts(db, {
      conversationId: input.conversationId,
      studentId: input.studentId,
    });

    const decision = continuityDecision({
      language: detected.language,
      key: detected.key,
      existing: rows.map(({ artifact }) => ({
        id: artifact.id,
        language: artifact.language,
        key: artifact.key,
        updatedAt: artifact.updatedAt.getTime(),
      })),
    });

    if (decision.kind === "new") {
      const created = createArtifact(db, {
        studentId: input.studentId,
        conversationId: input.conversationId,
        language: detected.language,
        key: decision.key,
        title: detected.title ?? artifactTitle(detected.source),
      });

      const version = appendArtifactVersion(db, {
        artifactId: created.id,
        messageId: input.messageId,
        source: detected.source,
        authoredBy: "model",
      });

      recorded.push({
        artifactId: created.id,
        versionId: version.id,
        language: detected.language,
        key: effectiveArtifactKey(created),
        unchanged: false,
      });
      continue;
    }

    const existing = rows.find(({ artifact }) => artifact.id === decision.artifactId);
    // The row was resolved out of `rows` a line ago; this is a type narrowing.
    if (!existing) continue;

    if (detected.key && existing.artifact.key !== detected.key) {
      setArtifactKey(db, { artifactId: existing.artifact.id, key: detected.key });
    }
    if (existing.artifact.language !== detected.language) {
      setArtifactLanguage(db, {
        artifactId: existing.artifact.id,
        language: detected.language,
      });
    }

    // An explicit `title=` renames; a title read out of the source only names
    // what is still unnamed, so a later revision cannot quietly retitle the
    // thing a pupil has been calling something else.
    const title =
      detected.title ?? (existing.artifact.title ? null : artifactTitle(detected.source));
    if (title) setArtifactTitle(db, { artifactId: existing.artifact.id, title });

    const key = effectiveArtifactKey({
      language: detected.language,
      id: existing.artifact.id,
      key: detected.key ?? existing.artifact.key,
    });

    if (existing.latest.source === detected.source) {
      recorded.push({
        artifactId: existing.artifact.id,
        versionId: existing.latest.id,
        language: detected.language,
        key,
        unchanged: true,
      });
      continue;
    }

    const version = appendArtifactVersion(db, {
      artifactId: existing.artifact.id,
      messageId: input.messageId,
      source: detected.source,
      authoredBy: "model",
    });

    recorded.push({
      artifactId: existing.artifact.id,
      versionId: version.id,
      language: detected.language,
      key,
      unchanged: false,
    });
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
    // The id the model must reuse to change it — the same identity it writes on
    // its own blocks, so the carried source is something it can answer in kind.
    key: effectiveArtifactKey(artifact),
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
