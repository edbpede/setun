import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { conversation } from "./conversation";
import { createdAt, primaryId } from "./helpers";
import { message } from "./message";
import { student } from "./student";

/**
 * A file a student attached to a message (PRD §10, §19, §21).
 *
 * "Uploads are validated server-side — content sniffing against the allowlist,
 * size limits — stored locally alongside generated images, served only by Setun
 * to their owner, and deleted with their conversation."
 *
 * The bytes are never in this table: it holds the path of a file kept outside
 * any web root, so nothing can be reached by guessing a URL on a static host
 * (§21).
 */

/** Images go to the model as images; text and code are inlined as text (§10). */
export const ATTACHMENT_KINDS = ["image", "text"] as const;
export type AttachmentKind = (typeof ATTACHMENT_KINDS)[number];

export const attachment = sqliteTable(
  "attachment",
  {
    id: primaryId(),
    /** The owner. Every read is scoped by it; there is no other way in (§21). */
    studentId: text()
      .notNull()
      .references(() => student.id, { onDelete: "cascade" }),
    /**
     * Set once the message it belongs to exists.
     *
     * An upload precedes its message — the student picks the file, then writes —
     * so the reference is filled in at send time. An attachment that never gets
     * one belongs to an abandoned draft.
     */
    messageId: text().references(() => message.id, { onDelete: "cascade" }),
    /**
     * Recorded at upload so retention can delete an attachment with its
     * conversation even when the draft it belonged to was never sent (§16).
     */
    conversationId: text().references(() => conversation.id, { onDelete: "cascade" }),
    kind: text({ enum: ATTACHMENT_KINDS }).notNull(),
    /** The sniffed type, not the browser's claim — that claim is not evidence (§21). */
    mediaType: text().notNull(),
    filename: text().notNull(),
    byteSize: integer().notNull(),
    /** Relative to the storage root, which is outside any web root (§21). */
    storagePath: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("attachment_student_idx").on(t.studentId),
    index("attachment_message_idx").on(t.messageId),
  ],
);

export type Attachment = typeof attachment.$inferSelect;

/**
 * Every media type the attachment sniffer can produce — the whole set an
 * educator's allowlist can usefully contain (§10).
 *
 * Here rather than beside the sniffer because the classroom column that holds
 * the allowlist is typed by it, and a schema cannot import from the storage
 * layer that imports from the schema.
 *
 * The educator's control is bounded by this rather than by free text: a type
 * `sniffMediaType` cannot return is an allowlist entry that never matches, which
 * is a control that decides nothing. Adding a format means adding a signature in
 * `storage/attachments.ts`, and this list follows from it.
 */
export const ATTACHMENT_MEDIA_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "text/plain",
] as const;

export type AttachmentMediaType = (typeof ATTACHMENT_MEDIA_TYPES)[number];
