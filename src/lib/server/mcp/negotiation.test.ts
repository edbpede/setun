import { describe, expect, it } from "bun:test";
import { normaliseError } from "./legacy/errors";
import { CredentialPromptRefused, normaliseToolResult } from "./legacy/results";
import { isExpiredSession, SESSION_HEADER, withSessionHeader } from "./legacy/session";
import { negotiate } from "./negotiation";
import { McpError } from "./protocol";
import { StreamableHttpTransport } from "./transport";

/**
 * Protocol version negotiation and legacy normalisation (plan 3.1, PRD §11, §22).
 *
 * §22 names "MCP protocol version negotiation and legacy normalisation" as
 * `bun test` coverage, and these are the three seams §11 says compatibility runs
 * through: the discovery probe with its fallback, the absent result-type field,
 * and the two error-code ranges.
 */

/** A server that answers a scripted response per JSON-RPC method. */
function stubServer(
  handlers: Record<string, (params: unknown) => unknown>,
  options: { sessionId?: string; contentType?: string } = {},
) {
  const calls: { method: string; params: unknown; headers: Headers }[] = [];

  const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const payload = JSON.parse(String(init?.body)) as {
      id?: number;
      method: string;
      params: unknown;
    };
    calls.push({
      method: payload.method,
      params: payload.params,
      headers: new Headers(init?.headers),
    });

    const handler = handlers[payload.method];
    const body = handler
      ? { jsonrpc: "2.0", id: payload.id, result: handler(payload.params) }
      : {
          jsonrpc: "2.0",
          id: payload.id,
          error: { code: -32601, message: `unknown method ${payload.method}` },
        };

    const headers = new Headers({ "content-type": options.contentType ?? "application/json" });
    if (options.sessionId) headers.set(SESSION_HEADER, options.sessionId);

    const text =
      options.contentType === "text/event-stream"
        ? `event: message\ndata: ${JSON.stringify(body)}\n\n`
        : JSON.stringify(body);

    return new Response(text, { status: 200, headers });
  }) as unknown as typeof globalThis.fetch;

  return { fetch, calls };
}

describe("version negotiation", () => {
  it("prefers the discovery probe and records the version the server named", async () => {
    const server = stubServer({
      "server/discover": () => ({
        protocolVersion: "2026-07-28",
        capabilities: { tools: {}, elicitation: {} },
        cache: { freshnessSeconds: 120, scope: "server" },
      }),
    });

    const outcome = await negotiate(
      new StreamableHttpTransport({ url: "http://mcp.test/mcp", fetch: server.fetch }),
    );

    expect(outcome.version).toBe("2026-07-28");
    expect(outcome.legacy).toBe(false);
    expect(outcome.capabilities).toEqual({ tools: true, elicitation: true });
    expect(outcome.hints).toEqual({ freshnessSeconds: 120, scope: "server" });
    expect(server.calls.map((call) => call.method)).toEqual(["server/discover"]);
  });

  it("falls back to the legacy handshake when discovery is unsupported", async () => {
    const server = stubServer(
      {
        initialize: () => ({
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "old", version: "1" },
        }),
        "notifications/initialized": () => ({}),
      },
      { sessionId: "session-abc" },
    );

    const outcome = await negotiate(
      new StreamableHttpTransport({ url: "http://mcp.test/mcp", fetch: server.fetch }),
    );

    expect(outcome.version).toBe("2025-06-18");
    expect(outcome.legacy).toBe(true);
    expect(outcome.sessionId).toBe("session-abc");
    // The handshake is only complete once the client has acknowledged it.
    expect(server.calls.map((call) => call.method)).toEqual([
      "server/discover",
      "initialize",
      "notifications/initialized",
    ]);
  });

  it("carries the legacy session identifier on every subsequent request", async () => {
    const server = stubServer(
      {
        initialize: () => ({ protocolVersion: "2025-06-18", capabilities: { tools: {} } }),
        "notifications/initialized": () => ({}),
        "tools/list": () => ({ tools: [] }),
      },
      { sessionId: "session-xyz" },
    );

    const transport = new StreamableHttpTransport({
      url: "http://mcp.test/mcp",
      fetch: server.fetch,
    });
    await negotiate(transport);
    await transport.request("tools/list", {});

    const listing = server.calls.at(-1);
    expect(listing?.headers.get(SESSION_HEADER)).toBe("session-xyz");
  });

  it("reads a response that arrived as an event stream rather than a JSON body", async () => {
    const server = stubServer(
      { "server/discover": () => ({ protocolVersion: "2026-07-28", capabilities: {} }) },
      { contentType: "text/event-stream" },
    );

    const outcome = await negotiate(
      new StreamableHttpTransport({ url: "http://mcp.test/mcp", fetch: server.fetch }),
    );

    expect(outcome.version).toBe("2026-07-28");
  });

  it("does not swallow a real failure as a reason to fall back", async () => {
    const fetch = (async () =>
      new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32603, message: "boom" } }),
        { headers: { "content-type": "application/json" } },
      )) as unknown as typeof globalThis.fetch;

    const attempt = negotiate(new StreamableHttpTransport({ url: "http://mcp.test/mcp", fetch }));
    await expect(attempt).rejects.toThrow(McpError);
  });
});

describe("legacy session semantics", () => {
  it("omits the header when no session is held, and adds it when one is", () => {
    expect(withSessionHeader({ accept: "application/json" }, null)).toEqual({
      accept: "application/json",
    });
    expect(withSessionHeader({}, "abc")[SESSION_HEADER]).toBe("abc");
  });

  it("reads a 404 as an expired session only while a session is held", () => {
    expect(isExpiredSession(404, "abc")).toBe(true);
    // A stateless server's 404 is a wrong endpoint, not an expired session.
    expect(isExpiredSession(404, null)).toBe(false);
    expect(isExpiredSession(500, "abc")).toBe(false);
  });
});

describe("legacy error-code ranges", () => {
  it("maps the codes JSON-RPC itself defines, which never moved", () => {
    expect(normaliseError({ code: -32601, message: "no such method" }).kind).toBe(
      "method-not-found",
    );
    expect(normaliseError({ code: -32602, message: "bad params" }).kind).toBe("invalid-params");
    expect(normaliseError({ code: -32700, message: "parse" }).kind).toBe("invalid-request");
  });

  it("maps the legacy application band", () => {
    expect(normaliseError({ code: -32002, message: "gone" }).kind).toBe("not-found");
    expect(normaliseError({ code: -32001, message: "stopped" }).kind).toBe("cancelled");
    // An unrecognised code inside the reserved band is still a server error.
    expect(normaliseError({ code: -32050, message: "?" }).kind).toBe("server-error");
  });

  it("maps the renumbered band outside the reserved range", () => {
    expect(normaliseError({ code: 1002, message: "Tool not found" }).kind).toBe("not-found");
    expect(normaliseError({ code: 1003, message: "Unauthorized" }).kind).toBe("unauthorised");
    expect(normaliseError({ code: 1009, message: "something else" }).kind).toBe("server-error");
  });

  it("keeps the original code in the operator detail and out of the message", () => {
    const error = normaliseError({ code: -32002, message: "no such resource" });
    expect(error.detail).toContain("-32002");
    // The student-facing path renders its own sentence from `kind` (§21).
    expect(error.message).toBe("mcp not-found");
  });
});

describe("legacy result normalisation", () => {
  it("reads a content item with no type field as text", () => {
    const result = normaliseToolResult({ content: [{ text: "42" }] });
    expect(result.content).toEqual([{ type: "text", text: "42" }]);
    expect(result.isError).toBe(false);
  });

  it("accepts the newer explicit shapes unchanged", () => {
    const result = normaliseToolResult({
      content: [
        { type: "text", text: "hej" },
        { type: "image", data: "AAA", mimeType: "image/png" },
      ],
      isError: true,
      structuredContent: { answer: 1 },
    });

    expect(result.content).toEqual([
      { type: "text", text: "hej" },
      { type: "image", data: "AAA", mediaType: "image/png" },
    ]);
    expect(result.isError).toBe(true);
    expect(result.structured).toEqual({ answer: 1 });
  });

  it("drops a content type this revision does not model rather than guessing", () => {
    const result = normaliseToolResult({ content: [{ type: "audio", data: "x" }] });
    expect(result.content).toEqual([]);
  });
});

describe("elicitation normalisation", () => {
  it("keeps only the flat primitives §11 allows", () => {
    const result = normaliseToolResult({
      content: [],
      elicitation: {
        message: "Which city?",
        requestedSchema: {
          type: "object",
          required: ["city"],
          properties: {
            city: { type: "string", title: "City" },
            days: { type: "integer" },
            imperial: { type: "boolean" },
            unit: { enum: ["c", "f"] },
            nested: { type: "object" },
            many: { type: "array" },
          },
        },
      },
    });

    expect(result.elicitation?.message).toBe("Which city?");
    expect(result.elicitation?.fields.map((field) => [field.name, field.type])).toEqual([
      ["city", "text"],
      ["days", "number"],
      ["imperial", "boolean"],
      ["unit", "choice"],
    ]);
    expect(result.elicitation?.fields[0].required).toBe(true);
    expect(result.elicitation?.fields[1].required).toBe(false);
  });

  it("accepts an elicitation carried in _meta as well as at the top level", () => {
    const result = normaliseToolResult({
      content: [],
      _meta: { elicitation: { message: "Pick one", requestedSchema: { properties: {} } } },
    });
    expect(result.elicitation?.message).toBe("Pick one");
  });

  it("refuses anything resembling a credential prompt outright (§11, §21)", () => {
    expect(() =>
      normaliseToolResult({
        content: [],
        elicitation: {
          message: "Sign in to continue",
          requestedSchema: { properties: { user: { type: "string" } } },
        },
      }),
    ).toThrow(CredentialPromptRefused);

    expect(() =>
      normaliseToolResult({
        content: [],
        elicitation: {
          message: "Which account?",
          requestedSchema: { properties: { apiKey: { type: "string", title: "API key" } } },
        },
      }),
    ).toThrow(CredentialPromptRefused);
  });

  it("leaves an ordinary result with no elicitation", () => {
    expect(
      normaliseToolResult({ content: [{ type: "text", text: "done" }] }).elicitation,
    ).toBeNull();
  });
});
