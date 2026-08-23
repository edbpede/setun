import { Database } from "bun:sqlite";
import { type BunSQLiteDatabase, drizzle } from "drizzle-orm/bun-sqlite";
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

  // WAL keeps the streaming writer (turn events) from blocking readers; the
  // busy timeout covers the overlap of a boot migration and an open handle.
  sqlite.exec("PRAGMA journal_mode = WAL;");
  sqlite.exec("PRAGMA busy_timeout = 5000;");
  // Off by default in SQLite, and the schema leans on `references(...)` cascades
  // to delete a student's messages, turns and attachments with them (§16).
  sqlite.exec("PRAGMA foreign_keys = ON;");

  return drizzle(sqlite, { schema }) as AppDatabase;
}
