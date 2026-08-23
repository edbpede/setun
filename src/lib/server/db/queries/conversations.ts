import { and, desc, eq } from "drizzle-orm";
import type { AppDatabase } from "../client";
import { type Conversation, conversation } from "../schema";

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
  db.update(conversation)
    .set({ title: input.title, updatedAt: new Date() })
    .where(
      and(eq(conversation.id, input.conversationId), eq(conversation.studentId, input.studentId)),
    )
    .run();
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
  return deleted.length > 0;
}
