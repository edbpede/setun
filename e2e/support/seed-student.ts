import { provisionStudent } from "../../src/lib/server/auth/provisioning";
import { allowAlias } from "../../src/lib/server/db/queries/classroom-aliases";
import {
  createClassroom,
  listClassrooms,
  setClassroomState,
} from "../../src/lib/server/db/queries/classrooms";
import { createAlias, listAvailableAliases } from "../../src/lib/server/db/queries/model-aliases";
import { openE2eDatabase } from "./database";

/**
 * Provision a student in the end-to-end database and print the code as JSON.
 *
 * The application never reveals a code after provisioning (PRD §7), so a test
 * that needs to log in has to mint one through the same provisioning path the
 * educator panel will use — not scrape it from a log.
 *
 * Runs as a separate process against the same SQLite file; WAL mode makes the
 * concurrent write safe.
 *
 * The classroom is named by `SETUN_E2E_CLASSROOM`, and each suite names its own.
 * Playwright runs files in parallel, and a suite that locks or reschedules a
 * classroom would otherwise be reconfiguring the room another suite is chatting
 * in — which is a real failure of the *test setup*, not of the application, and
 * one that only shows up under the worker count CI happens to choose.
 */
const databasePath = process.env.SETUN_DATABASE_PATH;
const pepper = process.env.SETUN_STUDENT_CODE_PEPPER;
const classroomName = process.env.SETUN_E2E_CLASSROOM ?? "E2E";

if (!databasePath || !pepper) {
  console.error("SETUN_DATABASE_PATH and SETUN_STUDENT_CODE_PEPPER are required");
  process.exit(1);
}

// The run starts from a deleted directory, so this may reach the database
// before the application does — and beside other helpers doing the same.
const db = await openE2eDatabase(databasePath);

const classroom =
  listClassrooms(db).find((candidate) => candidate.name === classroomName) ??
  createClassroom(db, { name: classroomName });

if (listAvailableAliases(db).length === 0) {
  createAlias(db, { name: "E2E", gatewayModelId: "stub-model", dialect: "openai" });
}

// Allowlist every alias for the classroom and open it: a classroom with no
// allowlist and no schedule refuses everything, which is correct behaviour and
// not what the chat flows are testing (§8, §9).
for (const alias of listAvailableAliases(db)) {
  allowAlias(db, { classroomId: classroom.id, modelAliasId: alias.id });
}
setClassroomState(db, { classroomId: classroom.id, state: "open" });

const { student, code } = await provisionStudent(db, {
  classroomId: classroom.id,
  pepper,
});

console.log(JSON.stringify({ label: student.label, code: code.display }));
