import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { createdAt, primaryId } from "./helpers";

/** Rate limiting is applied on both axes independently (PRD §7, Appendix A). */
export const LOGIN_ATTEMPT_SCOPES = ["ip", "digest"] as const;
export type LoginAttemptScope = (typeof LOGIN_ATTEMPT_SCOPES)[number];

/**
 * Rate-limiting state, in SQLite because the PRD puts it in the application
 * rather than in Caddy (PRD §7).
 *
 * The `key` is an IP address or a credential digest — never a plaintext code,
 * which is neither stored nor logged anywhere (§7, §21).
 */
export const loginAttempt = sqliteTable(
  "login_attempt",
  {
    id: primaryId(),
    scope: text({ enum: LOGIN_ATTEMPT_SCOPES }).notNull(),
    key: text().notNull(),
    successful: integer({ mode: "boolean" }).notNull(),
    createdAt: createdAt(),
  },
  // Every read is "attempts for this key inside the trailing window".
  (t) => [index("login_attempt_scope_key_idx").on(t.scope, t.key, t.createdAt)],
);

export type LoginAttempt = typeof loginAttempt.$inferSelect;
