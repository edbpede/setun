import { eq } from "drizzle-orm";
import type { AppDatabase } from "../client";
import { type Classroom, classroom } from "../schema";

/**
 * Classroom reads and writes (PRD §8).
 *
 * Minimal at M1: the settings surface — availability, schedules, budgets,
 * instructions, policies — grows here in Phase 2.
 */

export function createClassroom(
  db: AppDatabase,
  input: { name: string; timezone?: string },
): Classroom {
  const [row] = db.insert(classroom).values(input).returning().all();
  return row;
}

export function getClassroom(db: AppDatabase, classroomId: string): Classroom | undefined {
  return db.select().from(classroom).where(eq(classroom.id, classroomId)).get();
}

export function listClassrooms(db: AppDatabase): Classroom[] {
  return db.select().from(classroom).all();
}
