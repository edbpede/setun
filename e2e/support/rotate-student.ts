import { rotateStudentCredential } from "../../src/lib/server/auth/provisioning";
import { listClassrooms } from "../../src/lib/server/db/queries/classrooms";
import { listClassroomStudents } from "../../src/lib/server/db/queries/students";
import { openE2eDatabase } from "./database";

/**
 * Rotate one pupil's credential from outside the application, and print the new
 * code as JSON.
 *
 * The panel path is covered by `educator.e2e.ts`; what this exists for is the
 * security assertion — that a *live session* dies the instant the credential
 * behind it is replaced (PRD §7, §21). That needs rotation to happen while a
 * signed-in browser is holding the old cookie, which is what this does.
 *
 * Usage: `bun run e2e/support/rotate-student.ts <label>`
 */
const databasePath = process.env.SETUN_DATABASE_PATH;
const pepper = process.env.SETUN_STUDENT_CODE_PEPPER;
const classroomName = process.env.SETUN_E2E_CLASSROOM ?? "E2E";
const label = process.argv[2];

if (!databasePath || !pepper || !label) {
  console.error("SETUN_DATABASE_PATH, SETUN_STUDENT_CODE_PEPPER and a label are required");
  process.exit(1);
}

const db = await openE2eDatabase(databasePath);
const classroom = listClassrooms(db).find((candidate) => candidate.name === classroomName);
if (!classroom) {
  console.error(`no classroom named '${classroomName}'`);
  process.exit(1);
}

const student = listClassroomStudents(db, classroom.id).find((row) => row.label === label);
if (!student) {
  console.error(`no pupil labelled '${label}' in '${classroomName}'`);
  process.exit(1);
}

const code = await rotateStudentCredential(db, {
  studentId: student.id,
  classroomId: classroom.id,
  pepper,
});
if (!code) {
  console.error("rotation refused");
  process.exit(1);
}

console.log(JSON.stringify({ label: student.label, code: code.display }));
