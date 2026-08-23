import { type AppDatabase, createDatabase } from "./client";
import { applyMigrations } from "./migrate";
import { createClassroom } from "./queries/classrooms";
import { createAlias } from "./queries/model-aliases";
import { createStudent } from "./queries/students";

/**
 * In-memory database fixtures for `bun test`.
 *
 * Suites run the committed migrations rather than pushing the schema directly,
 * so a schema change without a generated migration fails here instead of in
 * production (§22).
 *
 * This module is imported only by tests; it ships no production behaviour.
 */
export function createTestDatabase(): AppDatabase {
  const db = createDatabase(":memory:");
  applyMigrations(db);
  return db;
}

/** A classroom, an alias and a student — the minimum for a conversation. */
export function seedTestFixtures(
  db: AppDatabase,
  overrides: { label?: string; digest?: string } = {},
) {
  const classroom = createClassroom(db, { name: "7.B" });
  const alias = createAlias(db, {
    name: `Balanced-${crypto.randomUUID().slice(0, 8)}`,
    gatewayModelId: "test-model",
    dialect: "openai",
  });
  const student = createStudent(db, {
    classroomId: classroom.id,
    label: overrides.label ?? "brave-otter",
    credentialDigest: overrides.digest ?? crypto.randomUUID(),
    credentialHint: "ABCD",
  });

  return { classroom, alias, student };
}
