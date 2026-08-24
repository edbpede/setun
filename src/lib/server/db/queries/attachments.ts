import { and, count, eq, inArray, isNull } from "drizzle-orm";
import type { AppDatabase } from "../client";
import { type Attachment, type AttachmentKind, attachment } from "../schema";

/**
 * Attachment records (PRD §10, §19, §21).
 *
 * Owner-scoped throughout: "served only to their owner", and a lookup that took
 * an identifier without a student id would be the way around that (§21).
 */

/** The pending uploads of one student in one conversation — the draft's chips. */
function pendingOf(input: { studentId: string; conversationId: string }) {
  return and(
    eq(attachment.studentId, input.studentId),
    eq(attachment.conversationId, input.conversationId),
    isNull(attachment.messageId),
  );
}

/**
 * Insert one pending attachment, but only while the draft is under its cap.
 *
 * The count and the insert are one transaction because they are one decision:
 * counting in the route and inserting afterwards leaves a window in which two
 * uploads that each saw "room for one more" both take it, and a draft that was
 * capped at four arrives at the model carrying five (§10).
 *
 * Returns null when the cap is already met, which is the same refusal the
 * up-front validation gives — the caller reports `too-many` either way.
 */
export function recordAttachmentWithinLimit(
  db: AppDatabase,
  input: {
    studentId: string;
    conversationId: string;
    kind: AttachmentKind;
    mediaType: string;
    filename: string;
    byteSize: number;
    storagePath: string;
    maxPerMessage: number;
  },
): Attachment | null {
  const { maxPerMessage, ...values } = input;

  return db.transaction((tx) => {
    const pending =
      tx.select({ value: count() }).from(attachment).where(pendingOf(values)).get()?.value ?? 0;

    if (pending >= maxPerMessage) return null;

    return tx.insert(attachment).values(values).returning().get();
  });
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
  return db.select().from(attachment).where(pendingOf(input)).all();
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

/**
 * The attachments referenced by a set of messages, for their owner.
 *
 * Used to re-read the images on the active path when a turn is assembled: the
 * parts name the attachments, and this resolves them without a second
 * ownership question — the student id is in the query (§21).
 */
export function listAttachmentsByIds(
  db: AppDatabase,
  input: { attachmentIds: readonly string[]; studentId: string },
): Attachment[] {
  if (input.attachmentIds.length === 0) return [];

  return db
    .select()
    .from(attachment)
    .where(
      and(
        inArray(attachment.id, [...input.attachmentIds]),
        eq(attachment.studentId, input.studentId),
      ),
    )
    .all();
}
