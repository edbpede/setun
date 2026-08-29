import { and, asc, eq, isNull } from "drizzle-orm";
import type { AppDatabase } from "../client";
import { type Message, type MessagePart, type MessageRole, message } from "../schema";
import { indexMessage } from "./search";

/**
 * The message tree (PRD §10, §19).
 *
 * Messages are a tree, not a list: editing a prompt or regenerating a response
 * appends a sibling under the same parent and moves the conversation's active
 * leaf, so no history is ever overwritten.
 *
 * Ownership is enforced by the conversation these calls are scoped to — callers
 * resolve the conversation through `getOwnedConversation` first (§21).
 */

export function appendMessage(
  db: AppDatabase,
  input: {
    conversationId: string;
    parentId: string | null;
    role: MessageRole;
    parts: MessagePart[];
    inputTokens?: number | null;
    outputTokens?: number | null;
    usageEstimated?: boolean;
  },
): Message {
  const [row] = db
    .insert(message)
    .values({
      conversationId: input.conversationId,
      parentId: input.parentId,
      role: input.role,
      parts: input.parts,
      inputTokens: input.inputTokens ?? null,
      outputTokens: input.outputTokens ?? null,
      usageEstimated: input.usageEstimated ?? false,
    })
    .returning()
    .all();

  // The search index is maintained here rather than by a trigger: SQLite fires
  // triggers for foreign-key cascade deletes only with recursive triggers on,
  // and an index that outlived its conversation would be a privacy defect (§16).
  indexMessage(db, {
    messageId: row.id,
    conversationId: row.conversationId,
    parts: row.parts,
  });

  return row;
}

/**
 * Append a sibling of an existing message — the one operation behind both
 * editing a prompt and regenerating a response (§10).
 *
 * The new node shares the original's parent, so the branch point is the parent
 * and every earlier variant stays addressable.
 */
export function appendSibling(
  db: AppDatabase,
  input: { siblingOfId: string; conversationId: string; role: MessageRole; parts: MessagePart[] },
): Message | undefined {
  const original = db.select().from(message).where(eq(message.id, input.siblingOfId)).get();
  if (!original || original.conversationId !== input.conversationId) return undefined;

  return appendMessage(db, {
    conversationId: original.conversationId,
    parentId: original.parentId,
    role: input.role,
    parts: input.parts,
  });
}

export function getMessage(db: AppDatabase, messageId: string): Message | undefined {
  return db.select().from(message).where(eq(message.id, messageId)).get();
}

export function listConversationMessages(db: AppDatabase, conversationId: string): Message[] {
  return db
    .select()
    .from(message)
    .where(eq(message.conversationId, conversationId))
    .orderBy(asc(message.createdAt))
    .all();
}

/**
 * The path from the root to `leafId`, oldest first.
 *
 * This is the context the agent loop sends upstream: one branch of the tree, not
 * every message in the conversation (§10).
 */
export function getActivePath(db: AppDatabase, leafId: string): Message[] {
  const path: Message[] = [];
  const seen = new Set<string>();

  let cursor: string | null = leafId;
  while (cursor) {
    // A cycle cannot arise through the append API, but this walk is driven by
    // stored parent pointers and must terminate regardless.
    if (seen.has(cursor)) break;
    seen.add(cursor);

    const node: Message | undefined = getMessage(db, cursor);
    if (!node) break;

    path.push(node);
    cursor = node.parentId;
  }

  return path.reverse();
}

/** Direct children of a node — the variants a branch picker offers (§10). */
export function listChildren(db: AppDatabase, parentId: string): Message[] {
  return db
    .select()
    .from(message)
    .where(eq(message.parentId, parentId))
    .orderBy(asc(message.createdAt))
    .all();
}

/**
 * The siblings at a branch point — a node's parent's children, oldest first.
 *
 * Scoped to the conversation so a null parent (the root variants an edited first
 * prompt creates) means "this conversation's roots", not every conversation's,
 * and so the picker a message offers is always within the pupil's own thread.
 */
export function listSiblings(
  db: AppDatabase,
  conversationId: string,
  parentId: string | null,
): Message[] {
  return db
    .select()
    .from(message)
    .where(
      and(
        eq(message.conversationId, conversationId),
        parentId === null ? isNull(message.parentId) : eq(message.parentId, parentId),
      ),
    )
    .orderBy(asc(message.createdAt))
    .all();
}

/**
 * The tip of the branch rooted at `nodeId`, following the newest child each step.
 *
 * Switching to a sibling should land on that branch's latest state, so a pupil
 * flipping between variants sees each one as they last left it rather than at
 * some interior node. Terminates on the newest-child walk; the seen-set guards a
 * malformed tree the append API cannot produce.
 */
export function deepestLeaf(db: AppDatabase, nodeId: string): string {
  let cursor = nodeId;
  const seen = new Set<string>();

  for (;;) {
    if (seen.has(cursor)) break;
    seen.add(cursor);

    const children = listChildren(db, cursor);
    if (children.length === 0) break;
    // listChildren is oldest-first, so the last child is the newest branch.
    cursor = children[children.length - 1].id;
  }

  return cursor;
}

/** Records usage on the assistant message once the turn finishes (§10). */
export function recordMessageUsage(
  db: AppDatabase,
  input: {
    messageId: string;
    inputTokens: number;
    outputTokens: number;
    estimated: boolean;
  },
): void {
  db.update(message)
    .set({
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      usageEstimated: input.estimated,
    })
    .where(eq(message.id, input.messageId))
    .run();
}
