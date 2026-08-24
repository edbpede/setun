import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { createdAt, primaryId, updatedAt } from "./helpers";

/**
 * A configured MCP server (PRD §11, §19).
 *
 * "Servers are defined in a version-controlled configuration file on disk — an
 * endpoint is a security decision and belongs in reviewable config — with
 * credentials referenced by environment-variable name, never stored in the
 * database."
 *
 * So this row is not the definition; it is what the *application* learned and
 * decided about a definition that lives elsewhere: which configuration entry it
 * mirrors, what version was negotiated with it, whether the educator has it
 * switched on, and whether it answered last time we looked. Nothing here can
 * point Setun at a new endpoint, which is the point.
 */

/** The revision the internal model targets (§11). */
export const MCP_TARGET_PROTOCOL_VERSION = "2026-07-28";

export const MCP_REACHABILITY = ["unknown", "reachable", "unreachable"] as const;
export type McpReachability = (typeof MCP_REACHABILITY)[number];

export const mcpServer = sqliteTable("mcp_server", {
  id: primaryId(),
  /**
   * The key of this server's entry in the on-disk configuration file (§11).
   *
   * The join between reviewable config and application state. A row whose key
   * no longer appears in the file is inert: the catalogue never loads it and no
   * classroom can reach its tools.
   */
  configKey: text().notNull().unique(),
  /** Shown to educators; students see capabilities, never servers (§11). */
  label: text().notNull(),
  /**
   * The revision agreed at registration, stored per server and displayed in the
   * panel (§11). Null until the first successful probe.
   */
  negotiatedVersion: text(),
  /**
   * Legacy session identifier, when the negotiated revision needs one.
   *
   * Newer revisions are stateless, so this stays null for them; the legacy
   * adapter round-trips it on every request for the revisions that do not (§11).
   */
  sessionId: text(),
  /** The educator's switch. Absent enablement is a denial, as everywhere (§11). */
  enabled: integer({ mode: "boolean" }).notNull().default(false),
  reachability: text({ enum: MCP_REACHABILITY }).notNull().default("unknown"),
  lastProbedAt: integer({ mode: "timestamp_ms" }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export type McpServer = typeof mcpServer.$inferSelect;
