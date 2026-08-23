import { and, eq, inArray, isNull } from "drizzle-orm";
import type { AppDatabase } from "../client";
import { type Attachment, type AttachmentKind, attachment } from "../schema";

/**
 * Attachment records (PRD §10, §19, §21).
 *
 * Owner-scoped throughout: "served only to their owner", and a lookup that took
 * an identifier without a student id would be the way around that (§21).
 */

export function recordAttachment(
  db: AppDatabase,
  input: {
    studentId: string;
    conversationId: string;
    kind: AttachmentKind;
    mediaType: string;
    filename: string;
    byteSize: number;
    storagePath: string;
  },
): Attachment {
  return db.insert(attachment).values(input).returning().get();
}

/** One attachment, for its owner. Absent rather than forbidden for anyone else (§21). */
export function getOwnedAttachment(
  db: AppDatabase,
  input: { attachmentId: string; studentId: string },
): Attachment | undefined {
  return db
    .select()
    .from(attachment)
    .where(and(eq(attachment.id, input.attachmentId), eq(attachment.studentId, input.studentId)))
    .get();
}

/**
 * The student's attachments in one conversation that no message claims yet —
 * the draft they are about to send.
 */
export function listPendingAttachments(
  db: AppDatabase,
  input: { studentId: string; conversationId: string },
): Attachment[] {
  return db
    .select()
    .from(attachment)
    .where(
      and(
        eq(attachment.studentId, input.studentId),
        eq(attachment.conversationId, input.conversationId),
        isNull(attachment.messageId),
      ),
    )
    .all();
}

/** Claim uploads for the message that was just written. */
export function attachToMessage(
  db: AppDatabase,
  input: { attachmentIds: readonly string[]; messageId: string; studentId: string },
): void {
  if (input.attachmentIds.length === 0) return;

  db.update(attachment)
    .set({ messageId: input.messageId })
    .where(
      and(
        inArray(attachment.id, [...input.attachmentIds]),
        eq(attachment.studentId, input.studentId),
        isNull(attachment.messageId),
      ),
    )
    .run();
}

export function deleteAttachment(
  db: AppDatabase,
  input: { attachmentId: string; studentId: string },
): void {
  db.delete(attachment)
    .where(and(eq(attachment.id, input.attachmentId), eq(attachment.studentId, input.studentId)))
    .run();
}
