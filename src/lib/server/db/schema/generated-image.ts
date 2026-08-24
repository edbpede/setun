import { index, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { conversation } from "./conversation";
import { createdAt, primaryId } from "./helpers";
import { message } from "./message";
import { student } from "./student";

/**
 * An image the student generated (PRD §15, §16, §19).
 *
 * "Generated images are stored locally and served from Setun; no external image
 * URL is ever handed to the browser." The provider's URL is fetched once,
 * server-side, and never recorded — a stored URL would eventually be rendered.
 *
 * The message and conversation references are nullable because creations
 * outlive the conversations that produced them: "by default they persist until
 * the student or educator deletes them (the gallery is the student's
 * portfolio)" (§16), while conversations expire after thirty days.
 */
export const generatedImage = sqliteTable(
  "generated_image",
  {
    id: primaryId(),
    studentId: text()
      .notNull()
      .references(() => student.id, { onDelete: "cascade" }),
    /** Null once the conversation that produced it has expired (§16). */
    conversationId: text().references(() => conversation.id, { onDelete: "set null" }),
    messageId: text().references(() => message.id, { onDelete: "set null" }),
    /** Kept with the image: the gallery shows what was asked for (§13, §16). */
    prompt: text().notNull(),
    mediaType: text().notNull(),
    /** Relative to the storage root, which is outside any web root (§21). */
    storagePath: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("generated_image_student_idx").on(t.studentId, t.createdAt)],
);

export type GeneratedImage = typeof generatedImage.$inferSelect;
