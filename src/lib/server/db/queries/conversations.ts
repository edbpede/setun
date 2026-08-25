import { and, desc, eq } from "drizzle-orm";
import type { AppDatabase } from "../client";
import { type Conversation, conversation } from "../schema";
import { indexConversationTitle, removeConversationFromIndex } from "./search";

/**
 * Conversation reads and writes (PRD §10).
 *
 * Every function takes the owning student and filters on it in SQL. Student-to-
 * student isolation is a server-side invariant (§21), so there is deliberately
 * no "get by id" that trusts the caller to have checked ownership already.
 */

export function createConversation(
  db: AppDatabase,
  input: { studentId: string; modelAliasId: string; title?: string },
): Conversation {
  const [row] = db
    .insert(conversation)
    .values({
      studentId: input.studentId,
      modelAliasId: input.modelAliasId,
      title: input.title ?? null,
    })
    .returning()
    .all();
  return row;
}

/** Newest first, scoped to the owner. */
export function listConversations(db: AppDatabase, studentId: string): Conversation[] {
  return db
    .select()
    .from(conversation)
    .where(eq(conversation.studentId, studentId))
    .orderBy(desc(conversation.updatedAt))
    .all();
}

/** Returns undefined both when the row is absent and when it belongs to another student. */
export function getOwnedConversation(
  db: AppDatabase,
  input: { conversationId: string; studentId: string },
): Conversation | undefined {
  return db
    .select()
    .from(conversation)
    .where(
      and(eq(conversation.id, input.conversationId), eq(conversation.studentId, input.studentId)),
    )
    .get();
}

/** Moves the branch the conversation is currently reading (§10). */
export function setActiveLeaf(
  db: AppDatabase,
  input: { conversationId: string; studentId: string; messageId: string },
): void {
  db.update(conversation)
    .set({ activeLeafId: input.messageId, updatedAt: new Date() })
    .where(
      and(eq(conversation.id, input.conversationId), eq(conversation.studentId, input.studentId)),
    )
    .run();
}

export function setConversationTitle(
  db: AppDatabase,
  input: { conversationId: string; studentId: string; title: string },
): void {
  const updated = db
    .update(conversation)
    .set({ title: input.title, updatedAt: new Date() })
    .where(
      and(eq(conversation.id, input.conversationId), eq(conversation.studentId, input.studentId)),
    )
    .returning({ id: conversation.id })
    .all();

  // Only when the owner-scoped statement actually matched: a title indexed for a
  // conversation the caller does not own would be exactly the isolation hole the
  // scoping above exists to prevent (§21).
  if (updated.length > 0) {
    indexConversationTitle(db, { conversationId: input.conversationId, title: input.title });
  }
}

/** Messages, turns and buffered events go with it through the schema cascades (§16). */
export function deleteConversation(
  db: AppDatabase,
  input: { conversationId: string; studentId: string },
): boolean {
  const deleted = db
    .delete(conversation)
    .where(
      and(eq(conversation.id, input.conversationId), eq(conversation.studentId, input.studentId)),
    )
    .returning({ id: conversation.id })
    .all();

  // The cascade reaches every real table; a virtual table has no foreign keys,
  // so the index is cleared explicitly or a deleted conversation stays findable.
  if (deleted.length > 0) removeConversationFromIndex(db, input.conversationId);

  return deleted.length > 0;
}
