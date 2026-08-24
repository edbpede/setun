import { eq } from "drizzle-orm";
import { recordGeneratedImage } from "../../src/lib/server/db/queries/images";
import { student } from "../../src/lib/server/db/schema";
import { FileStore } from "../../src/lib/server/storage/files";
import { openE2eDatabase } from "./database";

/**
 * Give one student a generated image, so the creations gallery has both kinds
 * of creation to show (PRD §13, §16).
 *
 * Written through the same file store and the same query module the generation
 * path uses, so the row and the bytes on disk are exactly what a real generation
 * leaves behind — only the provider call is skipped. Adding an image-capable
 * alias instead would allowlist it into every other suite's classroom, and one
 * of those suites asserts that no alias carries the flag (§15).
 *
 * Usage: `SETUN_E2E_STUDENT_LABEL=<label> bun run e2e/support/seed-image.ts`
 */
const databasePath = process.env.SETUN_DATABASE_PATH;
const storagePath = process.env.SETUN_STORAGE_PATH;
const label = process.env.SETUN_E2E_STUDENT_LABEL;

if (!databasePath || !storagePath || !label) {
  console.error(
    "SETUN_DATABASE_PATH, SETUN_STORAGE_PATH and SETUN_E2E_STUDENT_LABEL are required",
  );
  process.exit(1);
}

/** A one-pixel PNG: a real image, small enough to hold here. */
const PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  ),
  (character) => character.charCodeAt(0),
);

const db = await openE2eDatabase(databasePath);
const owner = db.select().from(student).where(eq(student.label, label)).get();

if (!owner) {
  console.error(`no student labelled '${label}'`);
  process.exit(1);
}

const { storagePath: stored } = await new FileStore(storagePath).write({
  category: "images",
  ownerId: owner.id,
  bytes: PNG,
  extension: "png",
});

const image = recordGeneratedImage(db, {
  studentId: owner.id,
  prompt: "en blå firkant",
  mediaType: "image/png",
  storagePath: stored,
});

console.log(JSON.stringify({ id: image.id, prompt: image.prompt }));
