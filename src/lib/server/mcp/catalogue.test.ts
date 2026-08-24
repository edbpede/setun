import { describe, expect, it } from "bun:test";
import { DEFAULT_FRESHNESS_SECONDS, readToolList, ToolCatalogue } from "./catalogue";
import { filterParameterHeaders } from "./client";
import { McpConfigurationError, parseMcpConfig, resolveCredential } from "./config";

/**
 * Catalogue caching and server configuration (plan 3.1, 3.2, PRD §11, §22).
 *
 * §11 makes the cache a deliberate consequence of statelessness — "tool
 * catalogues are fetched once, cached server-wide honouring the advertised
 * freshness and cache-scope hints" — so the freshness and the scope are what is
 * asserted here, not merely that a second call is faster.
 */

const SERVER_SCOPE = { freshnessSeconds: 60, scope: "server" as const };

function counter(tools: string[]) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    fetcher: async () => {
      calls++;
      return tools.map((name) => ({ name, description: null, inputSchema: null }));
    },
  };
}

describe("tool catalogue cache", () => {
  it("fetches once and serves the cached copy while it is fresh", async () => {
    const catalogue = new ToolCatalogue();
    const source = counter(["search"]);

    const first = await catalogue.list({
      serverKey: "docs",
      hints: SERVER_SCOPE,
      sessionId: null,
      fetcher: source.fetcher,
      now: 0,
    });
    const second = await catalogue.list({
      serverKey: "docs",
      hints: SERVER_SCOPE,
      sessionId: null,
      fetcher: source.fetcher,
      now: 59_000,
    });

    expect(first).toEqual(second);
    expect(source.calls).toBe(1);
  });

  it("re-fetches once the advertised freshness has passed", async () => {
    const catalogue = new ToolCatalogue();
    const source = counter(["search"]);

    await catalogue.list({
      serverKey: "docs",
      hints: SERVER_SCOPE,
      sessionId: null,
      fetcher: source.fetcher,
      now: 0,
    });
    await catalogue.list({
      serverKey: "docs",
      hints: SERVER_SCOPE,
      sessionId: null,
      fetcher: source.fetcher,
      now: 60_001,
    });

    expect(source.calls).toBe(2);
  });

  it("applies its own freshness when the server advertises none", async () => {
    const catalogue = new ToolCatalogue();
    const source = counter(["search"]);
    const hints = { freshnessSeconds: null, scope: null };

    await catalogue.list({
      serverKey: "docs",
      hints,
      sessionId: null,
      fetcher: source.fetcher,
      now: 0,
    });
    await catalogue.list({
      serverKey: "docs",
      hints,
      sessionId: null,
      fetcher: source.fetcher,
      now: DEFAULT_FRESHNESS_SECONDS * 1000 - 1,
    });
    expect(source.calls).toBe(1);

    await catalogue.list({
      serverKey: "docs",
      hints,
      sessionId: null,
      fetcher: source.fetcher,
      now: DEFAULT_FRESHNESS_SECONDS * 1000 + 1,
    });
    expect(source.calls).toBe(2);
  });

  it("discards a session-scoped catalogue when the session is replaced", async () => {
    const catalogue = new ToolCatalogue();
    const source = counter(["search"]);
    const hints = { freshnessSeconds: 3600, scope: "session" as const };

    await catalogue.list({
      serverKey: "docs",
      hints,
      sessionId: "one",
      fetcher: source.fetcher,
      now: 0,
    });
    await catalogue.list({
      serverKey: "docs",
      hints,
      sessionId: "one",
      fetcher: source.fetcher,
      now: 1,
    });
    expect(source.calls).toBe(1);

    await catalogue.list({
      serverKey: "docs",
      hints,
      sessionId: "two",
      fetcher: source.fetcher,
      now: 2,
    });
    expect(source.calls).toBe(2);
  });

  it("keeps a server-scoped catalogue across a session change", async () => {
    const catalogue = new ToolCatalogue();
    const source = counter(["search"]);

    await catalogue.list({
      serverKey: "docs",
      hints: SERVER_SCOPE,
      sessionId: "one",
      fetcher: source.fetcher,
      now: 0,
    });
    await catalogue.list({
      serverKey: "docs",
      hints: SERVER_SCOPE,
      sessionId: "two",
      fetcher: source.fetcher,
      now: 1,
    });

    expect(source.calls).toBe(1);
  });

  it("caches per server rather than globally", async () => {
    const catalogue = new ToolCatalogue();
    const docs = counter(["search"]);
    const maths = counter(["plot"]);

    await catalogue.list({
      serverKey: "docs",
      hints: SERVER_SCOPE,
      sessionId: null,
      fetcher: docs.fetcher,
      now: 0,
    });
    const other = await catalogue.list({
      serverKey: "maths",
      hints: SERVER_SCOPE,
      sessionId: null,
      fetcher: maths.fetcher,
      now: 0,
    });

    expect(other.map((tool) => tool.name)).toEqual(["plot"]);
    expect(docs.calls).toBe(1);
    expect(maths.calls).toBe(1);
  });

  it("invalidates one server without disturbing the others", async () => {
    const catalogue = new ToolCatalogue();
    const source = counter(["search"]);

    await catalogue.list({
      serverKey: "docs",
      hints: SERVER_SCOPE,
      sessionId: null,
      fetcher: source.fetcher,
      now: 0,
    });
    catalogue.invalidate("docs");
    await catalogue.list({
      serverKey: "docs",
      hints: SERVER_SCOPE,
      sessionId: null,
      fetcher: source.fetcher,
      now: 1,
    });

    expect(source.calls).toBe(2);
  });
});

describe("tools/list normalisation", () => {
  it("keeps named tools and drops anything without a name", () => {
    const tools = readToolList({
      tools: [
        { name: "search", description: "Find things", inputSchema: { type: "object" } },
        { description: "nameless" },
        { name: "plot", title: "Draw a chart" },
      ],
    });

    expect(tools).toEqual([
      { name: "search", description: "Find things", inputSchema: { type: "object" } },
      { name: "plot", description: "Draw a chart", inputSchema: null },
    ]);
  });

  it("tolerates a result with no tools at all", () => {
    expect(readToolList({})).toEqual([]);
    expect(readToolList(null)).toEqual([]);
  });
});

describe("server configuration", () => {
  const valid = JSON.stringify({
    servers: {
      docs: {
        label: "Documents",
        url: "https://mcp.example.org/mcp",
        credentialEnv: "SETUN_MCP_DOCS",
      },
    },
  });

  it("parses a well-formed file", () => {
    const [server] = parseMcpConfig(valid);
    expect(server.key).toBe("docs");
    expect(server.url).toBe("https://mcp.example.org/mcp");
    expect(server.credentialEnv).toBe("SETUN_MCP_DOCS");
    // Header injection from tool parameters is off unless an operator opts in (§11).
    expect(server.parameterHeaderAllowlist).toEqual([]);
  });

  it("refuses a file that is not JSON, and one that is the wrong shape", () => {
    expect(() => parseMcpConfig("{")).toThrow(McpConfigurationError);
    expect(() => parseMcpConfig(JSON.stringify({ servers: { docs: { label: "x" } } }))).toThrow(
      McpConfigurationError,
    );
  });

  it("refuses an allowlist naming an authentication or hop-by-hop header (§11)", () => {
    for (const header of ["authorization", "cookie", "host"]) {
      const text = JSON.stringify({
        servers: {
          docs: {
            label: "Documents",
            url: "https://mcp.example.org/mcp",
            parameterHeaderAllowlist: [header],
          },
        },
      });
      expect(() => parseMcpConfig(text)).toThrow(McpConfigurationError);
    }
  });

  it("resolves a credential by name, and fails loudly when the variable is absent", () => {
    const [server] = parseMcpConfig(valid);

    expect(resolveCredential(server, { SETUN_MCP_DOCS: "secret" })).toBe("secret");
    expect(() => resolveCredential(server, {})).toThrow(McpConfigurationError);
  });

  it("never carries a credential in the parsed configuration itself (§11, §21)", () => {
    const [server] = parseMcpConfig(valid);
    expect(JSON.stringify(server)).not.toContain("secret");
  });
});

describe("header injection from tool parameters (§11)", () => {
  it("drops every parameter-supplied header when the allowlist is empty", () => {
    const { arguments: args, headers } = filterParameterHeaders(
      { query: "hej", _headers: { "x-tenant": "7b", authorization: "Bearer stolen" } },
      [],
    );

    expect(args).toEqual({ query: "hej" });
    expect(headers).toEqual({});
  });

  it("passes only the headers the operator allowlisted", () => {
    const { arguments: args, headers } = filterParameterHeaders(
      { query: "hej", _headers: { "x-tenant": "7b", "x-other": "no" } },
      ["x-tenant"],
    );

    expect(args).toEqual({ query: "hej" });
    expect(headers).toEqual({ "x-tenant": "7b" });
  });

  it("leaves ordinary arguments untouched", () => {
    expect(filterParameterHeaders({ query: "hej" }, ["x-tenant"])).toEqual({
      arguments: { query: "hej" },
      headers: {},
    });
  });
});
