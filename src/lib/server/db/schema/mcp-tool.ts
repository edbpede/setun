import { index, integer, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";
import { createdAt, primaryId, updatedAt } from "./helpers";
import { mcpServer } from "./mcp-server";

/**
 * One tool a configured server advertises (PRD §11, §19).
 *
 * Rows are written by the catalogue refresh, not by an educator: the panel
 * "registers nothing free-form; it toggles configured servers and selects which
 * individual tools are exposed per classroom" (§11). What an educator owns here
 * is `enabled` and `sensitive`; everything else is what the server said about
 * itself.
 */
export const mcpTool = sqliteTable(
  "mcp_tool",
  {
    id: primaryId(),
    serverId: text()
      .notNull()
      .references(() => mcpServer.id, { onDelete: "cascade" }),
    /** The name the server exposes and the model calls. */
    name: text().notNull(),
    description: text(),
    /** The advertised JSON Schema, forwarded to the model unchanged. */
    inputSchema: text({ mode: "json" }).$type<Record<string, unknown>>(),
    /**
     * Whether this tool may be offered at all.
     *
     * Distinct from the per-classroom allowlist: a newly discovered tool arrives
     * switched off, so a server that grows a tool overnight cannot reach a
     * classroom before an educator has looked at it (§11, §21).
     */
    enabled: integer({ mode: "boolean" }).notNull().default(false),
    /**
     * Flagged by the educator at enablement time; asks for confirmation in
     * standard mode, where unflagged tools run automatically (§11).
     */
    sensitive: integer({ mode: "boolean" }).notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("mcp_tool_server_name_unique").on(t.serverId, t.name),
    index("mcp_tool_server_idx").on(t.serverId),
  ],
);

export type McpTool = typeof mcpTool.$inferSelect;
