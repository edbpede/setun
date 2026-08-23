import { defineConfig } from "drizzle-kit";

/**
 * Drizzle Kit generates migration SQL from the schema; it never runs them.
 * Migrations are applied at server boot, before the listener starts (PRD §6).
 *
 * `dbCredentials.url` is only consulted by introspection commands, so the
 * development default here is deliberate — generation reads the schema alone.
 */
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/lib/server/db/schema/index.ts",
  out: "./drizzle",
  dbCredentials: { url: process.env.SETUN_DATABASE_PATH ?? "./data/setun.sqlite" },
  strict: true,
  verbose: true,
});
