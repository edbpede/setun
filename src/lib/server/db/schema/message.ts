import { type AnySQLiteColumn, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { conversation } from "./conversation";
import { createdAt, primaryId } from "./helpers";

/**
 * One content part of a message.
 *
 * Only text exists at M1. Image and file parts arrive with attachments (Phase
 * 3.11) and image generation (Phase 3.10); the union is the extension point.
 */
export type MessagePart = { type: "text"; text: string };

export const MESSAGE_ROLES = ["user", "assistant"] as const;
export type MessageRole = (typeof MESSAGE_ROLES)[number];

/**
 * A node in the conversation tree (PRD §10, §19).
 *
 * Editing a prompt or regenerating a response appends a sibling under the same
 * parent rather than mutating a row, so every branch stays inspectable. A null
 * `parentId` marks a root.
 */
export const message = sqliteTable(
  "message",
  {
    id: primaryId(),
    conversationId: text()
      .notNull()
      .references(() => conversation.id, { onDelete: "cascade" }),
    parentId: text().references((): AnySQLiteColumn => message.id, { onDelete: "cascade" }),
    role: text({ enum: MESSAGE_ROLES }).notNull(),
    parts: text({ mode: "json" }).$type<MessagePart[]>().notNull(),
    /** Recorded per assistant message; input and output stay separate (§10, §19). */
    inputTokens: integer(),
    outputTokens: integer(),
    /** True when the figures are Setun's estimate, not gateway-reported (§10). */
    usageEstimated: integer({ mode: "boolean" }).notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    index("message_conversation_idx").on(t.conversationId),
    index("message_parent_idx").on(t.parentId),
  ],
);

export type Message = typeof message.$inferSelect;
