import { createDatabase } from "../../src/lib/server/db/client";
import { allowAlias, disallowAlias } from "../../src/lib/server/db/queries/classroom-aliases";
import {
  listClassrooms,
  setClassroomState,
  updateClassroomSettings,
} from "../../src/lib/server/db/queries/classrooms";
import { listAvailableAliases } from "../../src/lib/server/db/queries/model-aliases";

/**
 * Drive one classroom's configuration from outside the application.
 *
 * The scheduling flow of §22 asserts what happens to a *running* server as a
 * classroom opens and closes, and some of those states — a weekly schedule with
 * no lesson today — have no panel control that produces them in one click. This
 * writes them directly, against the same SQLite file the server is serving, so
 * the assertions afterwards go through the real request path.
 *
 * Runs as a separate process; WAL mode makes the concurrent write safe.
 *
 * Usage: `bun run e2e/support/classroom-control.ts <command> [argument]`
 */

const databasePath = process.env.SETUN_DATABASE_PATH;

if (!databasePath) {
  console.error("SETUN_DATABASE_PATH is required");
  process.exit(1);
}

const db = createDatabase(databasePath);
const classroom = listClassrooms(db)[0];

if (!classroom) {
  console.error("no classroom to control — seed one first");
  process.exit(1);
}

const [command, argument] = process.argv.slice(2);

switch (command) {
  case "open":
    setClassroomState(db, { classroomId: classroom.id, state: "open" });
    break;

  case "lock":
    setClassroomState(db, { classroomId: classroom.id, state: "locked" });
    break;

  /** Hand the room back to a schedule that has no lesson at any time. */
  case "closed-schedule":
    updateClassroomSettings(db, { classroomId: classroom.id, settings: { weeklySchedule: [] } });
    setClassroomState(db, { classroomId: classroom.id, state: "scheduled" });
    break;

  /** A weekly lesson, given as `weekday:startMinute:endMinute`. */
  case "schedule": {
    const [weekday, startMinute, endMinute] = (argument ?? "").split(":").map(Number);
    updateClassroomSettings(db, {
      classroomId: classroom.id,
      settings: { weeklySchedule: [{ weekday, startMinute, endMinute }] },
    });
    setClassroomState(db, { classroomId: classroom.id, state: "scheduled" });
    break;
  }

  /** Take every alias off this classroom's allowlist — the disabled-model case. */
  case "disallow-models":
    for (const alias of listAvailableAliases(db)) {
      disallowAlias(db, { classroomId: classroom.id, modelAliasId: alias.id });
    }
    break;

  case "allow-models":
    for (const alias of listAvailableAliases(db)) {
      allowAlias(db, { classroomId: classroom.id, modelAliasId: alias.id });
    }
    break;

  /** Leave the pupil no allowance for today. */
  case "exhaust-allowance":
    updateClassroomSettings(db, {
      classroomId: classroom.id,
      // One token: any turn at all has already spent more than the day allows.
      settings: { perStudentDailyTokens: 1 },
    });
    break;

  case "restore-allowance":
    updateClassroomSettings(db, {
      classroomId: classroom.id,
      settings: { perStudentDailyTokens: 250_000 },
    });
    break;

  default:
    console.error(`unknown command: ${command}`);
    process.exit(1);
}

console.log(JSON.stringify({ classroomId: classroom.id, command }));
