import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createDatabase } from "../../src/lib/server/db/client";
import { applyMigrations } from "../../src/lib/server/db/migrate";
import { createClassroom, listClassrooms } from "../../src/lib/server/db/queries/classrooms";
import { createAlias, listAvailableAliases } from "../../src/lib/server/db/queries/model-aliases";
import { provisionStudent } from "../../src/lib/server/auth/provisioning";

/**
 * Provision a student in the end-to-end database and print the code as JSON.
 *
 * The application never reveals a code after provisioning (PRD §7), so a test
 * that needs to log in has to mint one through the same provisioning path the
 * educator panel will use — not scrape it from a log.
 *
 * Runs as a separate process against the same SQLite file; WAL mode makes the
 * concurrent write safe.
 */
const databasePath = process.env.SETUN_DATABASE_PATH;
const pepper = process.env.SETUN_STUDENT_CODE_PEPPER;

if (!databasePath || !pepper) {
  console.error("SETUN_DATABASE_PATH and SETUN_STUDENT_CODE_PEPPER are required");
  process.exit(1);
}

// The run starts from a deleted directory, and this may reach the database
// before the application does.
mkdirSync(dirname(databasePath), { recursive: true });

const db = createDatabase(databasePath);
applyMigrations(db);

const classroom = listClassrooms(db)[0] ?? createClassroom(db, { name: "E2E" });

if (listAvailableAliases(db).length === 0) {
  createAlias(db, { name: "E2E", gatewayModelId: "stub-model", dialect: "openai" });
}

const { student, code } = await provisionStudent(db, {
  classroomId: classroom.id,
  pepper,
});

console.log(JSON.stringify({ label: student.label, code: code.display }));
