import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase } from "./client";
import { applyMigrations, MIGRATIONS_FOLDER } from "./migrate";
import { getClassroom } from "./queries/classrooms";

/**
 * Migrations apply to a database that already holds data (PRD §6).
 *
 * Applying them at boot means a broken migration is a failed start, not a failed
 * deploy step — so the committed set has to survive the upgrade path, not merely
 * a fresh `CREATE TABLE`.
 *
 * The trap this exists to catch: SQLite refuses `ALTER TABLE … ADD COLUMN` for a
 * `NOT NULL` column unless the DDL carries a constant default, and it refuses a
 * non-constant one such as `unixepoch()`. Drizzle's `$defaultFn` is applied by
 * the client at insert time and never reaches the DDL, so a column defaulted
 * that way generates a migration that passes on an empty table and fails on a
 * populated one — which is to say, in production only.
 */

interface JournalEntry {
  readonly idx: number;
  readonly tag: string;
}

function readJournal(): { entries: JournalEntry[] } {
  return JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8"));
}

/**
 * A migrations folder holding every migration up to and including `throughIdx`,
 * as an older deployment's image would have shipped.
 */
function migrationsThrough(throughIdx: number, dir: string): string {
  const journal = readJournal();
  const entries = journal.entries.filter((entry) => entry.idx <= throughIdx);

  mkdirSync(join(dir, "meta"), { recursive: true });
  for (const entry of entries) {
    const file = `${entry.tag}.sql`;
    writeFileSync(join(dir, file), readFileSync(join(MIGRATIONS_FOLDER, file), "utf8"));
  }
  writeFileSync(join(dir, "meta", "_journal.json"), JSON.stringify({ ...journal, entries }));

  return dir;
}

describe("applyMigrations", () => {
  it("upgrades a populated database through every committed migration", () => {
    const journal = readJournal();
    const latest = journal.entries.at(-1);
    if (!latest) throw new Error("the journal has no migrations");
    // Nothing to prove with a single migration; this becomes real from 0001 on.
    expect(journal.entries.length).toBeGreaterThan(1);

    const root = mkdtempSync(join(tmpdir(), "setun-migrate-"));
    const db = createDatabase(join(root, "setun.sqlite"));

    // Stand up the schema as it was one migration ago, and put a row in it —
    // the pilot database always has at least the seeded classroom.
    applyMigrations(db, migrationsThrough(latest.idx - 1, join(root, "previous")));
    db.$client.exec(
      "INSERT INTO classroom (id, name, timezone, createdAt, updatedAt) VALUES ('c1', 'Pilotklasse', 'Europe/Copenhagen', 1, 1)",
    );

    expect(() => applyMigrations(db)).not.toThrow();

    // The existing row picks up the Appendix A defaults rather than nulls.
    const upgraded = getClassroom(db, "c1");
    expect(upgraded?.state).toBe("scheduled");
    expect(upgraded?.weeklySchedule).toEqual([]);
    expect(upgraded?.perTurnTokenCap).toBe(100_000);
    expect(upgraded?.perStudentDailyTokens).toBe(250_000);
    expect(upgraded?.costExchangeRate).toBe(7);
  });

  it("is idempotent — a second application changes nothing", () => {
    const root = mkdtempSync(join(tmpdir(), "setun-migrate-"));
    const db = createDatabase(join(root, "setun.sqlite"));

    applyMigrations(db);
    expect(() => applyMigrations(db)).not.toThrow();
  });
});
