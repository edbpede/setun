import { provisionStudent } from "../../src/lib/server/auth/provisioning";
import { allowAlias } from "../../src/lib/server/db/queries/classroom-aliases";
import {
  createClassroom,
  listClassrooms,
  setClassroomState,
} from "../../src/lib/server/db/queries/classrooms";
import {
  createAlias,
  getAliasByName,
  listAvailableAliases,
} from "../../src/lib/server/db/queries/model-aliases";
import type { ModelAlias } from "../../src/lib/server/db/schema";
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

/**
 * The alias every suite chats through, made by whichever helper reaches the
 * empty table first.
 *
 * Each suite seeds its own classroom, but they share this one row, and
 * Playwright starts their helpers side by side — so "if none exist, create one"
 * is two decisions with a gap between them: both processes read an empty table,
 * both insert the same unique name, and the second is refused. Losing that race
 * means the row now exists, which is all this wanted, so the winner's row is
 * read rather than the suite failing on it (§9).
 */
function ensureAlias(name: string): ModelAlias {
  const existing = getAliasByName(db, name);
  if (existing) return existing;

  try {
    return createAlias(db, { name, gatewayModelId: "stub-model", dialect: "openai" });
  } catch (cause) {
    const winner = getAliasByName(db, name);
    if (!winner) throw cause;
    return winner;
  }
}

ensureAlias("E2E");

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
