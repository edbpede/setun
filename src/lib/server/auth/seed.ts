import type { AppDatabase } from "../db/client";
import { createClassroom, listClassrooms } from "../db/queries/classrooms";
import { createAlias, listAvailableAliases } from "../db/queries/model-aliases";
import { provisionStudent } from "./provisioning";

/**
 * First-boot development seed (plan 1.3).
 *
 * M1 has to be verifiable before the Phase 5 provisioning UI exists, so an empty
 * database gets one classroom, one student, and the aliases the gateway needs —
 * with the access code printed once to the operator console, the same "shown
 * exactly once" rule the credential card follows (§7).
 *
 * Idempotent: a database with any classroom in it is left alone, so a restart
 * never mints a second code or silently replaces the first.
 */

export interface SeedResult {
  readonly seeded: boolean;
  readonly classroomId?: string;
  readonly studentLabel?: string;
  /** Present only on the boot that created it, and never persisted (§7). */
  readonly accessCode?: string;
}

export async function seedDevelopmentData(
  db: AppDatabase,
  input: { pepper: string; defaultModelId?: string },
): Promise<SeedResult> {
  if (listClassrooms(db).length > 0) return { seeded: false };

  const classroom = createClassroom(db, { name: "Pilotklasse" });

  // Two aliases: one for chat, one designated for internal utility work (§10).
  const model = input.defaultModelId ?? "gpt-4o-mini";
  if (listAvailableAliases(db).length === 0) {
    createAlias(db, { name: "Balanced", gatewayModelId: model, dialect: "openai" });
    createAlias(db, {
      name: "Utility",
      gatewayModelId: model,
      dialect: "openai",
      isUtility: true,
    });
  }

  const { student, code } = await provisionStudent(db, {
    classroomId: classroom.id,
    pepper: input.pepper,
  });

  return {
    seeded: true,
    classroomId: classroom.id,
    studentLabel: student.label,
    accessCode: code.display,
  };
}
