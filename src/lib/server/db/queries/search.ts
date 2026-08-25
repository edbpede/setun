import { sql } from "drizzle-orm";
import type { AppDatabase } from "../client";
import type { MessagePart } from "../schema";

/**
 * Full-text search over one student's own conversations (PRD §10, §18, §21).
 *
 * "Conversation list with search" (§18), scoped absolutely: "Students see only
 * their own conversations" (§16), and cross-student search isolation is a named
 * security test (§22). The owner is a column on every indexed row and a
 * predicate on every read here — a result belonging to another student is not
 * filtered out downstream, it is never selected.
 *
 * FTS5 is a virtual table, so it lives in hand-written migration SQL rather than
 * in the Drizzle schema, and index maintenance is explicit: the write paths in
 * `queries/messages` and `queries/conversations` call in here. A trigger would
 * have been tempting, but SQLite fires triggers for foreign-key cascade deletes
 * only when recursive triggers are enabled — an index that silently retained a
 * deleted conversation's text would be a privacy defect, not a stale cache.
 */

/** Appendix A: `unicode61` with `remove_diacritics 2`, so Danish text searches forgivingly. */
export const SEARCH_TOKENIZER = "unicode61 remove_diacritics 2";

export const SEARCH_TABLE = "search_index";

/** What produced an indexed row. Both are the student's own text or their model's. */
export type SearchKind = "message" | "title";

export interface SearchHit {
  readonly conversationId: string;
  readonly title: string | null;
  readonly updatedAt: Date;
  /** A plain-text excerpt around the match. No markup: nothing here is trusted (§21). */
  readonly excerpt: string;
}

/** Rows scanned before grouping, so one long conversation cannot crowd out the rest. */
const SCAN_LIMIT = 200;

/** Conversations returned. A search box, not a report. */
export const SEARCH_RESULT_LIMIT = 20;

/**
 * The text a message contributes to the index.
 *
 * Prose only. Tool arguments and results are machine chatter the student never
 * wrote and would not search for, and attachment filenames are metadata; both
 * would dilute ranking without helping anyone find anything.
 */
export function indexableText(parts: readonly MessagePart[]): string {
  return parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

/**
 * Turn what a student typed into an FTS5 MATCH expression.
 *
 * Every token is quoted, so the FTS5 query grammar — `NEAR`, `OR`, `*`, column
 * filters — is inert: a pupil typing `AND` searches for the word. The final
 * token gets a prefix match, because a search box is read as you type.
 *
 * Returns null when nothing searchable remains, which the caller reports as no
 * results rather than as an error.
 */
export function toMatchExpression(raw: string): string | null {
  const tokens = raw.match(/[\p{L}\p{N}_]+/gu);
  if (!tokens || tokens.length === 0) return null;

  return tokens
    .map((token, i) => (i === tokens.length - 1 ? `"${token}"*` : `"${token}"`))
    .join(" ");
}

/**
 * Index a message's prose.
 *
 * The owner is read from the conversation in the same statement rather than
 * passed in: the caller holds a conversation id, and a mis-passed owner would be
 * an isolation hole that no test of the caller would notice.
 */
export function indexMessage(
  db: AppDatabase,
  input: { messageId: string; conversationId: string; parts: readonly MessagePart[] },
): void {
  removeMessageFromIndex(db, input.messageId);

  const body = indexableText(input.parts);
  if (body.length === 0) return;

  db.run(
    sql`insert into ${sql.identifier(SEARCH_TABLE)} (body, kind, sourceId, conversationId, studentId)
        select ${body}, 'message', ${input.messageId}, id, studentId
        from conversation where id = ${input.conversationId}`,
  );
}

/** Index a conversation's title, replacing whatever the previous title indexed. */
export function indexConversationTitle(
  db: AppDatabase,
  input: { conversationId: string; title: string },
): void {
  db.run(
    sql`delete from ${sql.identifier(SEARCH_TABLE)}
        where kind = 'title' and sourceId = ${input.conversationId}`,
  );

  if (input.title.trim().length === 0) return;

  db.run(
    sql`insert into ${sql.identifier(SEARCH_TABLE)} (body, kind, sourceId, conversationId, studentId)
        select ${input.title}, 'title', id, id, studentId
        from conversation where id = ${input.conversationId}`,
  );
}

export function removeMessageFromIndex(db: AppDatabase, messageId: string): void {
  db.run(
    sql`delete from ${sql.identifier(SEARCH_TABLE)} where kind = 'message' and sourceId = ${messageId}`,
  );
}

/** Called wherever a conversation goes: the student deleting it, and retention (§16). */
export function removeConversationFromIndex(db: AppDatabase, conversationId: string): void {
  db.run(sql`delete from ${sql.identifier(SEARCH_TABLE)} where conversationId = ${conversationId}`);
}

/**
 * Called when a pupil's record is permanently deleted (§16).
 *
 * Their conversations cascade away; this virtual table has no foreign keys, so
 * without it their text would remain searchable by nobody and stored forever —
 * which is precisely what permanent deletion is supposed to prevent.
 */
export function removeStudentFromIndex(db: AppDatabase, studentId: string): void {
  db.run(sql`delete from ${sql.identifier(SEARCH_TABLE)} where studentId = ${studentId}`);
}

interface ScanRow {
  readonly conversationId: string;
  readonly excerpt: string;
  readonly title: string | null;
  readonly updatedAt: number;
}

/**
 * Search one student's conversations, best match first.
 *
 * Rows are scanned in rank order and collapsed to one hit per conversation, so a
 * conversation that matches ten times appears once, at its best match.
 */
export function searchConversations(
  db: AppDatabase,
  input: { studentId: string; query: string; limit?: number },
): SearchHit[] {
  const match = toMatchExpression(input.query);
  if (!match) return [];

  const rows = db.all<ScanRow>(
    sql`select s.conversationId as conversationId,
               snippet(${sql.identifier(SEARCH_TABLE)}, 0, '', '', '…', 12) as excerpt,
               c.title as title,
               c.updatedAt as updatedAt
        from ${sql.identifier(SEARCH_TABLE)} s
        join conversation c on c.id = s.conversationId
        where ${sql.identifier(SEARCH_TABLE)} match ${match}
          and s.studentId = ${input.studentId}
        order by rank
        limit ${SCAN_LIMIT}`,
  );

  const seen = new Set<string>();
  const hits: SearchHit[] = [];
  const limit = input.limit ?? SEARCH_RESULT_LIMIT;

  for (const row of rows) {
    if (seen.has(row.conversationId)) continue;
    seen.add(row.conversationId);

    hits.push({
      conversationId: row.conversationId,
      title: row.title,
      updatedAt: new Date(row.updatedAt),
      excerpt: row.excerpt,
    });

    if (hits.length >= limit) break;
  }

  return hits;
}
