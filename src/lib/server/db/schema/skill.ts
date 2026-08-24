import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { createdAt, primaryId, updatedAt } from "./helpers";
import { student } from "./student";

/**
 * A skill (PRD §12, §19).
 *
 * "A skill is a name, a description, an instruction body, and optional bundled
 * reference material. Skill names and one-line descriptions are injected into
 * the system prompt; the full body is retrieved on demand through an internal
 * load tool, so skills cost almost nothing until used."
 *
 * Every column below exists because §12 draws a line with it: where the text
 * came from, whose conversations it may touch, whether an educator has looked at
 * it yet, and whether a student is still waiting for approval.
 */

/** Where the text came from. Everything but `panel` is untrusted input (§12, §21). */
export const SKILL_ORIGINS = ["panel", "upload", "import", "student"] as const;
export type SkillOrigin = (typeof SKILL_ORIGINS)[number];

/**
 * The approval gate for student authoring (§12).
 *
 * Only meaningful for student-owned skills: under the pre-approval policy "new
 * and edited versions sit inactive until the educator approves them", so an edit
 * moves an approved skill back to `pending`.
 */
export const SKILL_APPROVAL_STATES = ["approved", "pending", "rejected"] as const;
export type SkillApprovalState = (typeof SKILL_APPROVAL_STATES)[number];

/** One piece of bundled reference material, loaded with the body (§12). */
export interface SkillResource {
  readonly name: string;
  readonly text: string;
}

export const skill = sqliteTable(
  "skill",
  {
    id: primaryId(),
    origin: text({ enum: SKILL_ORIGINS }).notNull(),
    /**
     * The student who wrote it; null for the educator's library (§12).
     *
     * "Student-authored skills apply only to that student's conversations", and
     * this column is what makes that true rather than a UI convention (§21).
     */
    ownerStudentId: text().references(() => student.id, { onDelete: "cascade" }),
    name: text().notNull(),
    /** The one line injected into the system prompt alongside the name (§12). */
    description: text().notNull(),
    /** Retrieved on demand by the internal load tool, never injected wholesale (§12). */
    body: text().notNull(),
    resources: text({ mode: "json" }).$type<SkillResource[]>().notNull().default([]),
    /**
     * The educator's switch.
     *
     * "Imported and uploaded skill text is untrusted content: it arrives
     * disabled and takes effect only when the educator enables it" — hence the
     * default, which the upload and import paths rely on rather than restate
     * (§12, §21).
     */
    enabled: integer({ mode: "boolean" }).notNull().default(false),
    approvalState: text({ enum: SKILL_APPROVAL_STATES }).notNull().default("approved"),
    /**
     * Reserved by §12 and deliberately inert.
     *
     * "The schema reserves a marker for executable skills, but code-executing
     * skills… are explicitly deferred." Nothing reads this; it exists so the
     * deferral does not cost a migration later.
     */
    executable: integer({ mode: "boolean" }).notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("skill_owner_idx").on(t.ownerStudentId)],
);

export type Skill = typeof skill.$inferSelect;
