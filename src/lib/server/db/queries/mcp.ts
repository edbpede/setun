import { and, asc, eq } from "drizzle-orm";
import type { AppDatabase } from "../client";
import {
  classroomMcpTool,
  type McpReachability,
  type McpServer,
  type McpTool,
  mcpServer,
  mcpTool,
} from "../schema";

/**
 * MCP server and tool records (PRD §11, §19).
 *
 * These rows mirror decisions, not definitions: the endpoint and its credential
 * reference live in the on-disk configuration, and nothing here can change them.
 * What is written here is what the educator switched on and what the server said
 * about itself at the last probe.
 */

export function listMcpServers(db: AppDatabase): McpServer[] {
  return db.select().from(mcpServer).orderBy(asc(mcpServer.label)).all();
}

export function getMcpServer(db: AppDatabase, id: string): McpServer | undefined {
  return db.select().from(mcpServer).where(eq(mcpServer.id, id)).get();
}

export function getMcpServerByKey(db: AppDatabase, configKey: string): McpServer | undefined {
  return db.select().from(mcpServer).where(eq(mcpServer.configKey, configKey)).get();
}

/**
 * Register a configured server, or refresh the label of one already known.
 *
 * Enablement is never touched: an operator renaming a server in the file must
 * not silently switch it on, and a server switched on stays on across restarts.
 */
export function upsertMcpServer(
  db: AppDatabase,
  input: { configKey: string; label: string },
): McpServer {
  db.insert(mcpServer)
    .values({ configKey: input.configKey, label: input.label })
    .onConflictDoUpdate({ target: mcpServer.configKey, set: { label: input.label } })
    .run();

  const server = getMcpServerByKey(db, input.configKey);
  if (!server) throw new Error("mcp server row vanished after upsert");
  return server;
}

/** Record what a probe learned: the negotiated version and whether it answered (§11). */
export function recordMcpProbe(
  db: AppDatabase,
  input: {
    serverId: string;
    negotiatedVersion?: string | null;
    sessionId?: string | null;
    reachability: McpReachability;
    at?: Date;
  },
): void {
  db.update(mcpServer)
    .set({
      ...(input.negotiatedVersion !== undefined
        ? { negotiatedVersion: input.negotiatedVersion }
        : {}),
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
      reachability: input.reachability,
      lastProbedAt: input.at ?? new Date(),
    })
    .where(eq(mcpServer.id, input.serverId))
    .run();
}

export function setMcpServerEnabled(
  db: AppDatabase,
  input: { serverId: string; enabled: boolean },
): void {
  db.update(mcpServer)
    .set({ enabled: input.enabled })
    .where(eq(mcpServer.id, input.serverId))
    .run();
}

export function listMcpTools(db: AppDatabase, serverId: string): McpTool[] {
  return db
    .select()
    .from(mcpTool)
    .where(eq(mcpTool.serverId, serverId))
    .orderBy(asc(mcpTool.name))
    .all();
}

/**
 * Write what a catalogue refresh discovered.
 *
 * A tool already known keeps its enablement and its sensitive flag — those are
 * the educator's, not the server's. A newly discovered tool arrives disabled, by
 * the column default, so a server that grows a tool cannot reach a classroom
 * before an educator has looked at it (§11, §21).
 */
export function syncMcpTools(
  db: AppDatabase,
  input: {
    serverId: string;
    tools: readonly {
      name: string;
      description: string | null;
      inputSchema: Record<string, unknown> | null;
    }[];
  },
): void {
  for (const tool of input.tools) {
    db.insert(mcpTool)
      .values({
        serverId: input.serverId,
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })
      .onConflictDoUpdate({
        target: [mcpTool.serverId, mcpTool.name],
        set: { description: tool.description, inputSchema: tool.inputSchema },
      })
      .run();
  }
}

export function setMcpToolFlags(
  db: AppDatabase,
  input: { toolId: string; enabled?: boolean; sensitive?: boolean },
): void {
  db.update(mcpTool)
    .set({
      ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
      ...(input.sensitive === undefined ? {} : { sensitive: input.sensitive }),
    })
    .where(eq(mcpTool.id, input.toolId))
    .run();
}

export interface AllowedTool {
  readonly tool: McpTool;
  readonly server: McpServer;
}

/**
 * The tools one classroom may use, right now (§11, §21).
 *
 * Four conditions, all in SQL so no caller can forget one: the server is enabled,
 * the tool is enabled, the classroom allowlists it, and the row exists at all.
 * This is the single question the loop asks before offering a tool to a model or
 * executing a call.
 */
export function listAllowedTools(db: AppDatabase, classroomId: string): AllowedTool[] {
  return db
    .select({ tool: mcpTool, server: mcpServer })
    .from(classroomMcpTool)
    .innerJoin(mcpTool, eq(mcpTool.id, classroomMcpTool.mcpToolId))
    .innerJoin(mcpServer, eq(mcpServer.id, mcpTool.serverId))
    .where(
      and(
        eq(classroomMcpTool.classroomId, classroomId),
        eq(mcpTool.enabled, true),
        eq(mcpServer.enabled, true),
      ),
    )
    .orderBy(asc(mcpServer.label), asc(mcpTool.name))
    .all();
}

/** Allowlisted tool ids, including disabled ones — the panel edits the set itself. */
export function listAllowedToolIds(db: AppDatabase, classroomId: string): string[] {
  return db
    .select({ mcpToolId: classroomMcpTool.mcpToolId })
    .from(classroomMcpTool)
    .where(eq(classroomMcpTool.classroomId, classroomId))
    .all()
    .map((row) => row.mcpToolId);
}

export function allowTool(
  db: AppDatabase,
  input: { classroomId: string; mcpToolId: string },
): void {
  db.insert(classroomMcpTool)
    .values({ classroomId: input.classroomId, mcpToolId: input.mcpToolId })
    .onConflictDoNothing()
    .run();
}

export function disallowTool(
  db: AppDatabase,
  input: { classroomId: string; mcpToolId: string },
): void {
  db.delete(classroomMcpTool)
    .where(
      and(
        eq(classroomMcpTool.classroomId, input.classroomId),
        eq(classroomMcpTool.mcpToolId, input.mcpToolId),
      ),
    )
    .run();
}
