import { primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { classroom } from "./classroom";
import { createdAt } from "./helpers";
import { mcpTool } from "./mcp-tool";

/**
 * Which tools a classroom may use (PRD §11, §19).
 *
 * "Allowlists are join tables between Classroom and ModelAlias, McpTool, and
 * Skill respectively." An absent row is a denial, so a tool reaches a classroom
 * only after an educator has selected it there — and enforcement reads this on
 * every tool execution, never the browser's idea of what is available (§21).
 */
export const classroomMcpTool = sqliteTable(
  "classroom_mcp_tool",
  {
    classroomId: text()
      .notNull()
      .references(() => classroom.id, { onDelete: "cascade" }),
    mcpToolId: text()
      .notNull()
      .references(() => mcpTool.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.classroomId, t.mcpToolId] })],
);

export type ClassroomMcpTool = typeof classroomMcpTool.$inferSelect;
