import { eq } from "drizzle-orm";
import type { AppDatabase } from "../client";
import { type Classroom, classroom } from "../schema";

/**
 * Classroom reads and writes (PRD §8).
 *
 * Availability is written through `setClassroomState` rather than the general
 * settings update: the explicit state and its instant travel together, and
 * `stateChangedAt` is what the per-lesson session policy reads (§7). Letting a
 * settings form write `state` would silently move that boundary.
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

/**
 * The columns an educator may edit through the settings forms.
 *
 * Deliberately excludes `state`, `stateUntil` and `stateChangedAt` — see above.
 */
export type ClassroomSettingsUpdate = Partial<
  Pick<
    Classroom,
    | "name"
    | "timezone"
    | "weeklySchedule"
    | "temporaryWindows"
    | "sessionPolicy"
    | "sessionSlidingDays"
    | "conversationRetentionDays"
    | "creationRetentionDays"
    | "perTurnStepCap"
    | "perTurnWallClockSeconds"
    | "perTurnTokenCap"
    | "perStudentDailyTokens"
    | "perClassroomDailyTokens"
    | "permissionMode"
    | "skillAuthoringPolicy"
    | "attachmentsEnabled"
    | "attachmentTypes"
    | "classroomInstructions"
    | "interfaceLanguage"
    | "costExchangeRate"
  >
>;

export function updateClassroomSettings(
  db: AppDatabase,
  input: { classroomId: string; settings: ClassroomSettingsUpdate },
): Classroom | undefined {
  const [row] = db
    .update(classroom)
    .set({ ...input.settings, updatedAt: new Date() })
    .where(eq(classroom.id, input.classroomId))
    .returning()
    .all();
  return row;
}

/**
 * Apply an availability override (§8).
 *
 * `until` is null for an override that stands until the educator changes it —
 * always the case for Lock, and the case for an Open now with no duration.
 */
export function setClassroomState(
  db: AppDatabase,
  input: {
    classroomId: string;
    state: Classroom["state"];
    until?: Date | null;
    now?: Date;
  },
): Classroom | undefined {
  const [row] = db
    .update(classroom)
    .set({
      state: input.state,
      stateUntil: input.until ?? null,
      stateChangedAt: input.now ?? new Date(),
      updatedAt: new Date(),
    })
    .where(eq(classroom.id, input.classroomId))
    .returning()
    .all();
  return row;
}
