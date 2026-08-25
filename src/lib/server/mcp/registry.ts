import type { AppDatabase } from "../db/client";
import { recordMcpProbe, syncMcpTools, upsertMcpServer } from "../db/queries/mcp";
import type { McpServer } from "../db/schema";
import { describeCause } from "../logging";
import type { McpClient } from "./client";
import type { McpServerConfig } from "./config";

/**
 * Reconciling the configuration file with the database (PRD §11).
 *
 * The file is the definition; the rows are what the application decided about
 * it. This module is the only place the two meet, and it moves in one direction
 * only: a configuration entry can create a row, and no row can create a
 * configuration entry.
 */

/**
 * Register every configured server, without touching enablement.
 *
 * Called at boot. It contacts nothing — a server that is down must not delay the
 * listener, and an educator can see a registered-but-unreachable server in the
 * panel and act on it (§11).
 */
export function registerConfiguredServers(
  db: AppDatabase,
  servers: readonly McpServerConfig[],
): McpServer[] {
  return servers.map((server) =>
    upsertMcpServer(db, { configKey: server.key, label: server.label }),
  );
}

export interface RefreshOutcome {
  readonly serverId: string;
  readonly reachable: boolean;
  readonly negotiatedVersion: string | null;
  readonly toolCount: number;
}

/**
 * Probe one server and write what it advertises.
 *
 * Failure is recorded rather than thrown: the panel shows reachability, and one
 * unreachable server must not stop the others from refreshing (§11, §17).
 */
export async function refreshServer(
  db: AppDatabase,
  client: McpClient,
  server: McpServer,
  signal?: AbortSignal,
): Promise<RefreshOutcome> {
  try {
    const outcome = await client.probe(server.configKey, signal);
    const tools = await client.listTools(server.configKey, signal);

    syncMcpTools(db, { serverId: server.id, tools });
    recordMcpProbe(db, {
      serverId: server.id,
      negotiatedVersion: outcome.version,
      sessionId: outcome.sessionId,
      reachability: "reachable",
    });

    return {
      serverId: server.id,
      reachable: true,
      negotiatedVersion: outcome.version,
      toolCount: tools.length,
    };
  } catch (cause) {
    recordMcpProbe(db, { serverId: server.id, reachability: "unreachable" });
    // No upstream URL, credential or stack trace travels further than this line (§21).
    console.warn("mcp server unreachable", {
      configKey: server.configKey,
      cause: describeCause(cause),
    });

    return {
      serverId: server.id,
      reachable: false,
      negotiatedVersion: server.negotiatedVersion,
      toolCount: 0,
    };
  }
}

/** Refresh every registered server the configuration still names. */
export async function refreshAllServers(
  db: AppDatabase,
  client: McpClient,
  servers: readonly McpServer[],
  signal?: AbortSignal,
): Promise<RefreshOutcome[]> {
  const configured = new Set(client.serverKeys);
  const known = servers.filter((server) => configured.has(server.configKey));

  return Promise.all(known.map((server) => refreshServer(db, client, server, signal)));
}
