import { type AnySQLiteColumn, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { conversation } from "./conversation";
import { createdAt, primaryId } from "./helpers";

/**
 * What the student decided about a tool call (§11, §19).
 *
 * `auto` is the mode deciding without asking; the other three are what happened
 * when it did ask — including the case where nobody was there to answer.
 */
export const TOOL_DECISIONS = ["auto", "approved", "declined", "unanswered"] as const;
export type ToolDecision = (typeof TOOL_DECISIONS)[number];

/** Prose the model wrote or the student typed. */
export interface TextPart {
  readonly type: "text";
  readonly text: string;
}

/** A file the student attached; the bytes live outside any web root (§10, §21). */
export interface AttachmentPart {
  readonly type: "attachment";
  readonly attachmentId: string;
  readonly kind: "image" | "text";
  readonly filename: string;
  readonly mediaType: string;
}

/**
 * The student's own edit of an artifact, travelling to the model (§13).
 *
 * "When an artifact has been edited since the model last emitted it, the next
 * message in that conversation carries the current source, clearly marked as the
 * student's edited version — so \"I broke it, help me fix it\" works without
 * pasting code by hand."
 *
 * A part of its own rather than prose the client prepends: the marking has to
 * survive a reload, and the transcript has to show a compact reference rather
 * than a wall of code the pupil never typed.
 */
export interface ArtifactEditPart {
  readonly type: "artifact-edit";
  readonly artifactId: string;
  readonly versionId: string;
  readonly language: string;
  readonly title: string | null;
  readonly source: string;
}

/** An image produced by the generation path, served only by Setun (§15). */
export interface GeneratedImagePart {
  readonly type: "generated-image";
  readonly imageId: string;
  readonly prompt: string;
}

/**
 * A tool the model asked for, with what the permission mode decided (§11, §19).
 *
 * The decision is stored on the call rather than in a parallel list, so a
 * transcript cannot drift into attributing one student's refusal to another
 * call.
 */
export interface ToolCallPart {
  readonly type: "tool-call";
  readonly toolCallId: string;
  readonly toolName: string;
  /** The server the tool came from, for the attribution the student saw (§11). */
  readonly serverLabel: string | null;
  readonly arguments: unknown;
  readonly decision: ToolDecision;
}

/** What the tool answered. Untrusted input, never a privileged instruction (§11, §21). */
export interface ToolResultPart {
  readonly type: "tool-result";
  readonly toolCallId: string;
  readonly result: unknown;
  readonly isError: boolean;
}

/**
 * Why an answer stops short of where it was going (§10, §11).
 *
 * A part of its own, for the same reason `ArtifactEditPart` is one: the sign has
 * to survive a reload. The streaming container carries the reason live, but it
 * is cleared the moment the turn is replaced by its persisted message, so a
 * pupil who pressed Stop — or whose turn hit a per-turn cap — was left with a
 * sentence that simply ended, with nothing to say it had been cut short, either
 * then or on the next visit.
 *
 * Only the reasons a pupil can read something into: an answer that ended because
 * the model finished has nothing to announce. `error` is included because a
 * failed turn may still have persisted the words it managed to stream.
 */
export const TURN_NOTICES = ["aborted", "interrupted", "budget", "unanswered", "error"] as const;
export type TurnNotice = (typeof TURN_NOTICES)[number];

export interface TurnNoticePart {
  readonly type: "turn-notice";
  readonly notice: TurnNotice;
}

/**
 * One content part of a message (§19: "content parts, tool calls and results,
 * permission decisions").
 */
export type MessagePart =
  | TextPart
  | AttachmentPart
  | ArtifactEditPart
  | GeneratedImagePart
  | ToolCallPart
  | ToolResultPart
  | TurnNoticePart;

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
