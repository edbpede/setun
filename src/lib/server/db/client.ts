import { Database } from "bun:sqlite";
import { type BunSQLiteDatabase, drizzle } from "drizzle-orm/bun-sqlite";
import { logEnabled } from "../logging";
import * as schema from "./schema";

/**
 * The Drizzle handle, with the underlying `bun:sqlite` connection exposed.
 *
 * Drizzle attaches `$client` at runtime but omits it from the published type.
 * Declaring it here keeps the raw handle available for the few places that need
 * SQL Drizzle does not express — migrations, and tests asserting on raw rows —
 * without an `as any` at each call site.
 */
export type AppDatabase = BunSQLiteDatabase<typeof schema> & { $client: Database };

/**
 * Build a database handle over a SQLite file (or `:memory:`).
 *
 * A factory rather than only a singleton: `bun test` builds in-memory databases
 * per suite, and a module-level connection bound to env would make the query
 * modules untestable without a live environment.
 */
export function createDatabase(path: string): AppDatabase {
  const sqlite = new Database(path, { strict: true, create: true });

  // Set before anything that may contend: a connection without it fails
  // immediately rather than waiting for the lock it wants.
  sqlite.exec("PRAGMA busy_timeout = 5000;");

  enableWriteAheadLogging(sqlite);

  // Off by default in SQLite, and the schema leans on `references(...)` cascades
  // to delete a student's messages, turns and attachments with them (§16).
  sqlite.exec("PRAGMA foreign_keys = ON;");

  // Query logging is a development knob and off at every normal level: Drizzle
  // prints each statement *with its bound parameters*, which for this schema
  // means message bodies and artifact source. §16 keeps that out of a log, so
  // it takes an explicit `--log-level debug` to turn on.
  return drizzle(sqlite, { schema, logger: logEnabled("debug") }) as AppDatabase;
}

/**
 * Put the database in WAL mode, tolerating a race to do so.
 *
 * WAL keeps the streaming writer (turn events) from blocking readers. It is a
 * persistent property of the file rather than of a connection, so it only has
 * to be set once — and switching into it takes an exclusive lock that the busy
 * timeout does *not* cover: SQLite returns SQLITE_BUSY from a `journal_mode`
 * change immediately rather than invoking the busy handler.
 *
 * So: skip when it is already set, and treat a lost race as success, because
 * losing one means another connection is setting the very thing this wanted.
 */
function enableWriteAheadLogging(sqlite: Database): void {
  const current = sqlite.query("PRAGMA journal_mode").get() as { journal_mode?: string } | null;
  if (current?.journal_mode?.toLowerCase() === "wal") return;

  try {
    sqlite.exec("PRAGMA journal_mode = WAL;");
  } catch {
    // Another connection holds the lock precisely because it is doing this.
  }
}
