import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { createdAt, primaryId, updatedAt } from "./helpers";

/**
 * The unit of configuration (PRD §8).
 *
 * Minimal at M1 by design: availability, schedules, budgets, session policy,
 * instructions and feature flags are Phase 2 columns (plan 2.2). Only the
 * identity and the timezone exist now — the timezone because every later budget
 * day and schedule window is resolved in it (§8, §10).
 */
export const classroom = sqliteTable("classroom", {
  id: primaryId(),
  name: text().notNull(),
  /** IANA zone; `Europe/Copenhagen` is the PRD §8 default. */
  timezone: text().notNull().default("Europe/Copenhagen"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export type Classroom = typeof classroom.$inferSelect;
