import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { type AppDatabase, createDatabase } from "../../src/lib/server/db/client";
import { applyMigrations } from "../../src/lib/server/db/migrate";

/**
 * Open the end-to-end database from a helper process.
 *
 * The helpers run beside a live server against the same SQLite file, and a run
 * starts from a deleted directory — so on the first test of a run, several
 * helpers and the application itself may all reach an empty file at once and
 * each try to create the schema. Exactly one of them succeeds; the rest see the
 * table the winner just created and fail.
 *
 * The retry is the fix, and it belongs here rather than in `applyMigrations`:
 * a deployment migrates once, at boot, before the listener accepts anything
 * (§6). Concurrent migration is a property of this test harness, not of Setun.
 */
const ATTEMPTS = 10;
const BACKOFF_MS = 100;

export async function openE2eDatabase(databasePath: string): Promise<AppDatabase> {
  mkdirSync(dirname(databasePath), { recursive: true });

  let lastFailure: unknown;

  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    try {
      const db = createDatabase(databasePath);
      applyMigrations(db);
      return db;
    } catch (cause) {
      lastFailure = cause;
      await Bun.sleep(BACKOFF_MS);
    }
  }

  throw lastFailure;
}
