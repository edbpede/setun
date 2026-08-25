import { allowAlias, disallowAlias } from "../../src/lib/server/db/queries/classroom-aliases";
import {
  listClassrooms,
  setClassroomState,
  updateClassroomSettings,
} from "../../src/lib/server/db/queries/classrooms";
import { listAvailableAliases } from "../../src/lib/server/db/queries/model-aliases";
import { listClassroomStudents } from "../../src/lib/server/db/queries/students";
import { changeStudentStatus } from "../../src/lib/server/classroom/students";
import { openE2eDatabase } from "./database";

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
 * The classroom is named by `SETUN_E2E_CLASSROOM`, the same variable the seed
 * helper reads, so a suite reconfigures only its own room and never the one a
 * suite running in parallel is chatting in.
 *
 * Usage: `bun run e2e/support/classroom-control.ts <command> [argument]`
 */

const databasePath = process.env.SETUN_DATABASE_PATH;
const classroomName = process.env.SETUN_E2E_CLASSROOM ?? "E2E";

if (!databasePath) {
  console.error("SETUN_DATABASE_PATH is required");
  process.exit(1);
}

const db = await openE2eDatabase(databasePath);
const classroom = listClassrooms(db).find((candidate) => candidate.name === classroomName);

if (!classroom) {
  console.error(`no classroom named '${classroomName}' to control — seed one first`);
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

  /** Leave room for a short text file and nothing more — the size-cap case (§10). */
  case "tiny-attachment-caps":
    updateClassroomSettings(db, {
      classroomId: classroom.id,
      settings: { attachmentTextMaxBytes: 8, attachmentImageMaxBytes: 8 },
    });
    break;

  case "restore-attachment-caps":
    updateClassroomSettings(db, {
      classroomId: classroom.id,
      settings: { attachmentTextMaxBytes: 256 * 1024, attachmentImageMaxBytes: 5 * 1024 * 1024 },
    });
    break;

  /** Only images on the allowlist: a text file then has a type that is not allowed. */
  case "images-only-attachments":
    updateClassroomSettings(db, {
      classroomId: classroom.id,
      settings: { attachmentTypes: ["image/png"] },
    });
    break;

  case "restore-attachment-types":
    updateClassroomSettings(db, {
      classroomId: classroom.id,
      settings: {
        attachmentTypes: ["image/png", "image/jpeg", "image/webp", "text/plain"],
      },
    });
    break;

  case "disable-attachments":
    updateClassroomSettings(db, {
      classroomId: classroom.id,
      settings: { attachmentsEnabled: false },
    });
    break;

  case "enable-attachments":
    updateClassroomSettings(db, {
      classroomId: classroom.id,
      settings: { attachmentsEnabled: true },
    });
    break;

  case "restore-allowance":
    updateClassroomSettings(db, {
      classroomId: classroom.id,
      settings: { perStudentDailyTokens: 250_000 },
    });
    break;

  /**
   * Switch one pupil off, by label — the §16 disable, invalidating their
   * sessions in the same call exactly as the panel does (§7, §21).
   */
  case "disable-student": {
    const target = listClassroomStudents(db, classroom.id).find((row) => row.label === argument);
    if (!target) {
      console.error(`no pupil labelled '${argument}' in '${classroomName}'`);
      process.exit(1);
    }
    changeStudentStatus(db, {
      studentId: target.id,
      classroomId: classroom.id,
      status: "disabled",
    });
    break;
  }

  default:
    console.error(`unknown command: ${command}`);
    process.exit(1);
}

console.log(JSON.stringify({ classroomId: classroom.id, command }));
