import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { classroom } from "./classroom";
import { createdAt, primaryId } from "./helpers";
import { modelAlias } from "./model-alias";
import { student } from "./student";

/**
 * The source of allowance and cap accounting (PRD §10, §19).
 *
 * Written in Phase 1 so the record exists from the first turn; read and enforced
 * in Phase 2.7. Rows are retained indefinitely — volume is trivial at pilot scale.
 */
export const usageEvent = sqliteTable(
  "usage_event",
  {
    id: primaryId(),
    classroomId: text()
      .notNull()
      .references(() => classroom.id, { onDelete: "cascade" }),
    /**
     * Null for internal utility work (title generation), which counts against
     * the classroom cap only and never a student's personal allowance (§10).
     */
    studentId: text().references(() => student.id, { onDelete: "cascade" }),
    modelAliasId: text()
      .notNull()
      .references(() => modelAlias.id),
    inputTokens: integer().notNull(),
    outputTokens: integer().notNull(),
    toolCalls: integer().notNull().default(0),
    /**
     * False when the figures are gateway-reported, true when Setun estimated
     * them. Usage is never recorded as zero for a response that produced text (§10).
     */
    estimated: integer({ mode: "boolean" }).notNull(),
    createdAt: createdAt(),
  },
  // The budget day is a calendar day in the classroom timezone (§10), so both
  // accounting queries scan a time range within one classroom or one student.
  (t) => [
    index("usage_event_classroom_idx").on(t.classroomId, t.createdAt),
    index("usage_event_student_idx").on(t.studentId, t.createdAt),
  ],
);

export type UsageEvent = typeof usageEvent.$inferSelect;
