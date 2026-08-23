import { sqliteTable, text, unique } from "drizzle-orm/sqlite-core";
import { classroom } from "./classroom";
import { createdAt, primaryId, updatedAt } from "./helpers";

/**
 * A pseudonymous participant (PRD §7, §16).
 *
 * There is no email column, and there is no plaintext access code: the record
 * holds only the HMAC digest of the code and a short non-secret tail used to
 * identify a printed card during support (§7).
 */
export const student = sqliteTable(
  "student",
  {
    id: primaryId(),
    classroomId: text()
      .notNull()
      .references(() => classroom.id, { onDelete: "cascade" }),
    /** Generated word-pair label, unique within the classroom (§7, §17). */
    label: text().notNull(),
    /** Optional, student-set, freely cleared (§16). */
    displayName: text(),
    status: text({ enum: ["active", "disabled"] })
      .notNull()
      .default("active"),
    /** HMAC-SHA-256 of the access code under the env pepper. Uniquely indexed for direct lookup (§7). */
    credentialDigest: text().notNull().unique(),
    /** Non-secret trailing characters of the code. Identifies a card; cannot reconstruct it (§7). */
    credentialHint: text().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [unique("student_classroom_label_unique").on(t.classroomId, t.label)],
);

export type Student = typeof student.$inferSelect;
