import { index, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";
import { classroom } from "./classroom";
import { createdAt, primaryId } from "./helpers";
import { skill } from "./skill";
import { student } from "./student";

/**
 * Skill enablement, per classroom and per student (PRD §12, §19).
 *
 * "Allowlists are join tables between Classroom and ModelAlias, McpTool, and
 * Skill respectively; the Skill allowlist additionally supports per-student
 * rows" — because §12 offers a skill "to a whole class or to individual
 * students", and those are two different rows rather than two tables.
 *
 * A null `studentId` is the whole class. A row naming a student narrows it to
 * that student, and a class-wide row plus a student row are simply both true.
 *
 * The surrogate key exists because SQLite treats every NULL as distinct in a
 * unique index, so a composite primary key over a nullable column would let the
 * same class-wide grant be inserted twice.
 */
export const classroomSkill = sqliteTable(
  "classroom_skill",
  {
    id: primaryId(),
    classroomId: text()
      .notNull()
      .references(() => classroom.id, { onDelete: "cascade" }),
    skillId: text()
      .notNull()
      .references(() => skill.id, { onDelete: "cascade" }),
    /** Null offers the skill to the whole class; a value narrows it to one student. */
    studentId: text().references(() => student.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [
    unique("classroom_skill_unique").on(t.classroomId, t.skillId, t.studentId),
    index("classroom_skill_classroom_idx").on(t.classroomId),
  ],
);

export type ClassroomSkill = typeof classroomSkill.$inferSelect;
