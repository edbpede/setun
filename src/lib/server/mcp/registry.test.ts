import { describe, expect, it } from "bun:test";
import {
  getMcpServerByKey,
  listMcpServers,
  listMcpTools,
  setMcpToolFlags,
} from "../db/queries/mcp";
import { createTestDatabase } from "../db/testing";
import { ToolCatalogue } from "./catalogue";
import { McpClient } from "./client";
import type { McpServerConfig } from "./config";
import { refreshAllServers, refreshServer, registerConfiguredServers } from "./registry";

/**
 * Reconciling the configuration file with the database (plan 3.1, 3.3, PRD §11,
 * §21, §22).
 *
 * Two properties matter here and are asserted rather than assumed: a newly
 * discovered tool arrives switched off, so a server that grows one overnight
 * cannot reach a classroom before an educator has looked at it; and a refresh
 * never resets what an educator decided.
 */

const CONFIG: McpServerConfig[] = [
  {
    key: "docs",
    label: "Skolens dokumenter",
    url: "http://mcp.test/mcp",
    headers: {},
    parameterHeaderAllowlist: [],
  },
];

function server(tools: { name: string; description?: string }[]) {
  const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const payload = JSON.parse(String(init?.body)) as { id?: number; method: string };

    const result =
      payload.method === "server/discover"
        ? { protocolVersion: "2026-07-28", capabilities: { tools: {} } }
        : payload.method === "tools/list"
          ? { tools }
          : {};

    return new Response(JSON.stringify({ jsonrpc: "2.0", id: payload.id, result }), {
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;

  return new McpClient(CONFIG, { fetch, catalogue: new ToolCatalogue() });
}

function unreachable() {
  const fetch = (async () => {
    throw new Error("connect ECONNREFUSED");
  }) as unknown as typeof globalThis.fetch;

  return new McpClient(CONFIG, { fetch, catalogue: new ToolCatalogue() });
}

describe("registering configured servers", () => {
  it("creates one row per configuration entry, switched off", () => {
    const db = createTestDatabase();
    registerConfiguredServers(db, CONFIG);

    const [row] = listMcpServers(db);
    expect(row.configKey).toBe("docs");
    expect(row.label).toBe("Skolens dokumenter");
    // Absent enablement is a denial, as everywhere (§11, §21).
    expect(row.enabled).toBe(false);
    expect(row.negotiatedVersion).toBeNull();
    expect(row.reachability).toBe("unknown");
  });

  it("refreshes a renamed label without switching anything on or off", () => {
    const db = createTestDatabase();
    const [created] = registerConfiguredServers(db, CONFIG);
    setMcpToolFlags(db, { toolId: created.id, enabled: true });

    registerConfiguredServers(db, [{ ...CONFIG[0], label: "Dokumenter" }]);

    const row = getMcpServerByKey(db, "docs");
    expect(row?.label).toBe("Dokumenter");
    expect(row?.enabled).toBe(false);
  });

  it("stores no endpoint or credential reference in the database (§11, §21)", () => {
    const db = createTestDatabase();
    registerConfiguredServers(db, [
      { ...CONFIG[0], credentialEnv: "SETUN_MCP_DOCS", url: "https://secret.example.org/mcp" },
    ]);

    const serialised = JSON.stringify(listMcpServers(db));
    expect(serialised).not.toContain("secret.example.org");
    expect(serialised).not.toContain("SETUN_MCP_DOCS");
  });
});

describe("refreshing a server", () => {
  it("records the negotiated version and writes what it advertises", async () => {
    const db = createTestDatabase();
    const [row] = registerConfiguredServers(db, CONFIG);

    const outcome = await refreshServer(db, server([{ name: "search", description: "Find" }]), row);

    expect(outcome).toMatchObject({
      reachable: true,
      negotiatedVersion: "2026-07-28",
      toolCount: 1,
    });

    const stored = getMcpServerByKey(db, "docs");
    expect(stored?.negotiatedVersion).toBe("2026-07-28");
    expect(stored?.reachability).toBe("reachable");
    expect(stored?.lastProbedAt).toBeInstanceOf(Date);

    const [tool] = listMcpTools(db, row.id);
    expect(tool.name).toBe("search");
    // A newly discovered tool arrives switched off (§11, §21).
    expect(tool.enabled).toBe(false);
    expect(tool.sensitive).toBe(false);
  });

  it("keeps the educator's flags across a refresh", async () => {
    const db = createTestDatabase();
    const [row] = registerConfiguredServers(db, CONFIG);
    await refreshServer(db, server([{ name: "search", description: "Find" }]), row);

    const [before] = listMcpTools(db, row.id);
    setMcpToolFlags(db, { toolId: before.id, enabled: true, sensitive: true });

    await refreshServer(db, server([{ name: "search", description: "Find things" }]), row);

    const [after] = listMcpTools(db, row.id);
    // The description is the server's to change; the two flags are not.
    expect(after.description).toBe("Find things");
    expect(after.enabled).toBe(true);
    expect(after.sensitive).toBe(true);
  });

  it("records an unreachable server rather than failing the refresh (§11, §17)", async () => {
    const db = createTestDatabase();
    const [row] = registerConfiguredServers(db, CONFIG);

    const outcome = await refreshServer(db, unreachable(), row);

    expect(outcome.reachable).toBe(false);
    expect(getMcpServerByKey(db, "docs")?.reachability).toBe("unreachable");
  });

  it("skips a row whose configuration entry has been removed", async () => {
    const db = createTestDatabase();
    registerConfiguredServers(db, [
      ...CONFIG,
      {
        key: "gone",
        label: "Removed",
        url: "http://x/mcp",
        headers: {},
        parameterHeaderAllowlist: [],
      },
    ]);

    const outcomes = await refreshAllServers(db, server([{ name: "search" }]), listMcpServers(db));

    // Only the configured one was contacted; the other is inert (§11).
    expect(outcomes).toHaveLength(1);
    expect(getMcpServerByKey(db, "gone")?.reachability).toBe("unknown");
  });
});
