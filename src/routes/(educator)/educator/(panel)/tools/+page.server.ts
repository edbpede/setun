import { fail as kitFail } from "@sveltejs/kit";
import * as v from "valibot";
import { requireEducatorPage } from "$lib/server/auth/guards";
import { getDb, getMcpClient } from "$lib/server/boot";
import { McpServerStateSchema, McpToolStateSchema } from "$lib/server/classroom/schemas";
import {
  listMcpServers,
  listMcpTools,
  setMcpServerEnabled,
  setMcpToolFlags,
} from "$lib/server/db/queries/mcp";
import { refreshAllServers, refreshServer } from "$lib/server/mcp/registry";
import type { Actions, PageServerLoad } from "./$types";

/**
 * Configured MCP servers and their tools (PRD §11, §17).
 *
 * "The educator panel registers nothing free-form; it toggles configured servers
 * and selects which individual tools are exposed per classroom."
 *
 * So this page has no way to add a server: the list comes from the on-disk
 * configuration, and what an educator changes here is enablement, the sensitive
 * flag, and when Setun last contacted each one. The per-classroom selection
 * happens on the classroom page, where the class it applies to is on screen.
 */
export const load: PageServerLoad = ({ locals }) => {
  requireEducatorPage(locals);
  const db = getDb();
  const configured = new Set(getMcpClient()?.serverKeys ?? []);

  return {
    servers: listMcpServers(db).map((server) => ({
      id: server.id,
      configKey: server.configKey,
      label: server.label,
      enabled: server.enabled,
      negotiatedVersion: server.negotiatedVersion,
      reachability: server.reachability,
      lastProbedAt: server.lastProbedAt?.toISOString() ?? null,
      // A row whose configuration entry has gone is inert; the panel says so
      // rather than offering controls that would do nothing (§11).
      configured: configured.has(server.configKey),
      tools: listMcpTools(db, server.id).map((tool) => ({
        id: tool.id,
        name: tool.name,
        description: tool.description,
        enabled: tool.enabled,
        sensitive: tool.sensitive,
      })),
    })),
  };
};

export const actions: Actions = {
  /** Switch a configured server on or off for the whole installation (§11). */
  setServerEnabled: async ({ request, locals }) => {
    requireEducatorPage(locals);

    const body = await request.formData();
    const parsed = v.safeParse(McpServerStateSchema, {
      serverId: body.get("serverId"),
      enabled: body.get("enabled"),
    });
    if (!parsed.success) return kitFail(400, { invalid: true });

    setMcpServerEnabled(getDb(), {
      serverId: parsed.output.serverId,
      enabled: parsed.output.enabled === "true",
    });
    return { saved: true };
  },

  /**
   * Expose a tool at all, and mark it as one that asks first (§11).
   *
   * Both flags are installation-wide; a classroom then selects from what is
   * exposed. A tool switched off here is unreachable everywhere at once, which
   * is what makes it a usable control during a lesson.
   */
  setToolFlags: async ({ request, locals }) => {
    requireEducatorPage(locals);

    const body = await request.formData();
    const parsed = v.safeParse(McpToolStateSchema, {
      toolId: body.get("toolId"),
      enabled: body.get("enabled") ?? undefined,
      sensitive: body.get("sensitive") ?? undefined,
    });
    if (!parsed.success) return kitFail(400, { invalid: true });

    setMcpToolFlags(getDb(), {
      toolId: parsed.output.toolId,
      ...(parsed.output.enabled === undefined ? {} : { enabled: parsed.output.enabled === "true" }),
      ...(parsed.output.sensitive === undefined
        ? {}
        : { sensitive: parsed.output.sensitive === "true" }),
    });
    return { saved: true };
  },

  /** Contact one server: negotiate a version and refresh its catalogue (§11). */
  refresh: async ({ request, locals }) => {
    requireEducatorPage(locals);
    const client = getMcpClient();
    if (!client) return kitFail(409, { invalid: true });

    const body = await request.formData();
    const parsed = v.safeParse(v.object({ serverId: v.pipe(v.string(), v.uuid()) }), {
      serverId: body.get("serverId"),
    });
    if (!parsed.success) return kitFail(400, { invalid: true });

    const server = listMcpServers(getDb()).find(
      (candidate) => candidate.id === parsed.output.serverId,
    );
    if (!server) return kitFail(404, { invalid: true });

    const outcome = await refreshServer(getDb(), client, server);
    return { refreshed: outcome.reachable ? 1 : 0 };
  },

  refreshAll: async ({ locals }) => {
    requireEducatorPage(locals);
    const client = getMcpClient();
    if (!client) return kitFail(409, { invalid: true });

    const outcomes = await refreshAllServers(getDb(), client, listMcpServers(getDb()));
    return { refreshed: outcomes.filter((outcome) => outcome.reachable).length };
  },
};
