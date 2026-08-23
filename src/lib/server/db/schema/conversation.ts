import { index, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { createdAt, primaryId, updatedAt } from "./helpers";
import { modelAlias } from "./model-alias";
import { student } from "./student";

/**
 * A student's chat thread (PRD §10).
 *
 * Messages form a tree rather than a list, so the conversation tracks which leaf
 * is currently active; editing or regenerating moves it to a new sibling (§10).
 *
 * `activeLeafId` carries no foreign key: the message table references the
 * conversation, and a reciprocal constraint would make either row impossible to
 * insert first.
 */
export const conversation = sqliteTable(
  "conversation",
  {
    id: primaryId(),
    studentId: text()
      .notNull()
      .references(() => student.id, { onDelete: "cascade" }),
    /** Null until the async utility-alias title lands after the first exchange (§10). */
    title: text(),
    modelAliasId: text()
      .notNull()
      .references(() => modelAlias.id),
    activeLeafId: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  // Every conversation query is owner-scoped (§21), so the owner leads the index.
  (t) => [index("conversation_student_idx").on(t.studentId, t.updatedAt)],
);

export type Conversation = typeof conversation.$inferSelect;
