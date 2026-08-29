import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { createdAt, primaryId } from "./helpers";

/**
 * Rate limiting is applied on both axes independently (PRD §7, Appendix A).
 *
 * `ip-refused` is an audit scope, not a limiter axis. An attempt refused by the
 * per-IP ceiling never reaches the credential, so counting it as an `ip` attempt
 * would keep a window that should drain in fifteen minutes topped up for as long
 * as a client kept knocking — an indefinite lockout rather than the curve
 * Appendix A specifies. It is recorded under its own scope so the operator can
 * see that the limiter fired, and read back by nothing that decides anything.
 */
export const LOGIN_ATTEMPT_SCOPES = ["ip", "digest", "ip-refused"] as const;
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
