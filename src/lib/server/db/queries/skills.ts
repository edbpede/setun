import { and, asc, eq, isNull, or } from "drizzle-orm";
import type { AppDatabase } from "../client";
import {
  classroomSkill,
  type Skill,
  type SkillApprovalState,
  type SkillOrigin,
  type SkillResource,
  skill,
  student as studentTable,
} from "../schema";

/**
 * Skill records and their enablement (PRD §12, §19, §21).
 *
 * Two audiences, one table: the educator's library, and a student's own skills.
 * The difference is `ownerStudentId`, and every read below is written so that a
 * student-owned skill cannot be reached by anyone but its owner — "student-
 * authored skills apply only to that student's conversations" is enforced in
 * SQL, not in a caller's discipline (§12, §21).
 */

export function listLibrarySkills(db: AppDatabase): Skill[] {
  return db.select().from(skill).where(isNull(skill.ownerStudentId)).orderBy(asc(skill.name)).all();
}

export function listStudentSkills(db: AppDatabase, studentId: string): Skill[] {
  return db
    .select()
    .from(skill)
    .where(eq(skill.ownerStudentId, studentId))
    .orderBy(asc(skill.name))
    .all();
}

/** Every student-authored skill in one classroom — the oversight list of §12. */
export function listStudentSkillsForClassroom(
  db: AppDatabase,
  classroomId: string,
): { skill: Skill; studentLabel: string }[] {
  return db
    .select({ skill, studentLabel: studentTable.label })
    .from(skill)
    .innerJoin(studentTable, eq(studentTable.id, skill.ownerStudentId))
    .where(eq(studentTable.classroomId, classroomId))
    .orderBy(asc(studentTable.label), asc(skill.name))
    .all();
}

export function getSkill(db: AppDatabase, id: string): Skill | undefined {
  return db.select().from(skill).where(eq(skill.id, id)).get();
}

/** A student's own skill, by id. Absent rather than forbidden for anyone else (§21). */
export function getOwnedSkill(
  db: AppDatabase,
  input: { skillId: string; studentId: string },
): Skill | undefined {
  return db
    .select()
    .from(skill)
    .where(and(eq(skill.id, input.skillId), eq(skill.ownerStudentId, input.studentId)))
    .get();
}

export function createSkill(
  db: AppDatabase,
  input: {
    origin: SkillOrigin;
    name: string;
    description: string;
    body: string;
    resources?: SkillResource[];
    ownerStudentId?: string | null;
    enabled?: boolean;
    approvalState?: SkillApprovalState;
  },
): Skill {
  const created = db
    .insert(skill)
    .values({
      origin: input.origin,
      name: input.name,
      description: input.description,
      body: input.body,
      resources: input.resources ?? [],
      ownerStudentId: input.ownerStudentId ?? null,
      // Uploads and imports rely on the column default (`false`): untrusted text
      // arrives disabled and is switched on only by an educator (§12, §21).
      ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
      ...(input.approvalState ? { approvalState: input.approvalState } : {}),
    })
    .returning()
    .get();

  return created;
}

export function updateSkill(
  db: AppDatabase,
  input: {
    skillId: string;
    name?: string;
    description?: string;
    body?: string;
    resources?: SkillResource[];
    enabled?: boolean;
    approvalState?: SkillApprovalState;
  },
): void {
  db.update(skill)
    .set({
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.description === undefined ? {} : { description: input.description }),
      ...(input.body === undefined ? {} : { body: input.body }),
      ...(input.resources === undefined ? {} : { resources: input.resources }),
      ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
      ...(input.approvalState === undefined ? {} : { approvalState: input.approvalState }),
    })
    .where(eq(skill.id, input.skillId))
    .run();
}

export function deleteSkill(db: AppDatabase, skillId: string): void {
  db.delete(skill).where(eq(skill.id, skillId)).run();
}

/**
 * The skills active for one student, right now (§12).
 *
 * Two sources, one list:
 *
 *  - library skills the educator enabled and offered to this classroom, either
 *    class-wide (a null student on the join row) or to this student by name;
 *  - the student's own skills, which no join row governs because they reach
 *    nobody else.
 *
 * Both sides require `enabled` and an approved state, so a disabled skill is
 * absent from the prompt and unreachable by the load tool (§12, §21, §22).
 */
export function listActiveSkills(
  db: AppDatabase,
  input: { classroomId: string; studentId: string; includeStudentAuthored: boolean },
): Skill[] {
  const library = db
    .select({ skill })
    .from(classroomSkill)
    .innerJoin(skill, eq(skill.id, classroomSkill.skillId))
    .where(
      and(
        eq(classroomSkill.classroomId, input.classroomId),
        or(isNull(classroomSkill.studentId), eq(classroomSkill.studentId, input.studentId)),
        isNull(skill.ownerStudentId),
        eq(skill.enabled, true),
        eq(skill.approvalState, "approved"),
      ),
    )
    .all()
    .map((row) => row.skill);

  const own = input.includeStudentAuthored
    ? db
        .select()
        .from(skill)
        .where(
          and(
            eq(skill.ownerStudentId, input.studentId),
            eq(skill.enabled, true),
            eq(skill.approvalState, "approved"),
          ),
        )
        .all()
    : [];

  // A skill offered both class-wide and by name appears on one row each.
  const unique = new Map<string, Skill>();
  for (const entry of [...library, ...own]) unique.set(entry.id, entry);

  return [...unique.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function listSkillGrants(
  db: AppDatabase,
  classroomId: string,
): { skillId: string; studentId: string | null }[] {
  return db
    .select({ skillId: classroomSkill.skillId, studentId: classroomSkill.studentId })
    .from(classroomSkill)
    .where(eq(classroomSkill.classroomId, classroomId))
    .all();
}

export function grantSkill(
  db: AppDatabase,
  input: { classroomId: string; skillId: string; studentId?: string | null },
): void {
  const studentId = input.studentId ?? null;

  /**
   * The class-wide grant is checked by hand, because the unique index cannot
   * see it.
   *
   * `classroom_skill_unique` covers (classroomId, skillId, studentId), and a
   * class-wide grant leaves `studentId` NULL. SQLite treats NULLs as distinct
   * in a unique index, so the constraint never fires and `onConflictDoNothing`
   * has nothing to do nothing about — every press of the class-wide control
   * inserted another identical row. Per-pupil grants are unaffected and stay on
   * the index.
   */
  if (studentId === null) {
    const existing = db
      .select({ id: classroomSkill.id })
      .from(classroomSkill)
      .where(
        and(
          eq(classroomSkill.classroomId, input.classroomId),
          eq(classroomSkill.skillId, input.skillId),
          isNull(classroomSkill.studentId),
        ),
      )
      .get();
    if (existing) return;
  }

  db.insert(classroomSkill)
    .values({ classroomId: input.classroomId, skillId: input.skillId, studentId })
    .onConflictDoNothing()
    .run();
}

export function revokeSkill(
  db: AppDatabase,
  input: { classroomId: string; skillId: string; studentId?: string | null },
): void {
  db.delete(classroomSkill)
    .where(
      and(
        eq(classroomSkill.classroomId, input.classroomId),
        eq(classroomSkill.skillId, input.skillId),
        input.studentId
          ? eq(classroomSkill.studentId, input.studentId)
          : isNull(classroomSkill.studentId),
      ),
    )
    .run();
}
