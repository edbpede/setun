import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { createdAt, primaryId, updatedAt } from "./helpers";

/**
 * The single operator account, seeded from deployment configuration at first
 * boot (PRD §7, §6.2). Re-seeding and restarting remains a password-recovery
 * path; the supported CLI adds recovery for an operator with shell access.
 *
 * The hash is produced by `Bun.password` (argon2id) — seeding and verification
 * land with educator authentication in Phase 2.1.
 */
export const educator = sqliteTable("educator", {
  id: primaryId(),
  username: text().notNull().unique(),
  passwordHash: text().notNull(),
  /** Argon2id hash of the last deployment seed deliberately superseded by recovery. */
  supersededSeedHash: text(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export type Educator = typeof educator.$inferSelect;
