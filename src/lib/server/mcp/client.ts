import { type CatalogueEntry, readToolList, type ToolCatalogue, toolCatalogue } from "./catalogue";
import { type CredentialEnvironment, type McpServerConfig, resolveCredential } from "./config";
import { type McpToolResult, normaliseToolResult } from "./legacy/results";
import { type NegotiationOutcome, negotiate } from "./negotiation";
import { McpError } from "./protocol";
import { StreamableHttpTransport } from "./transport";

/**
 * The MCP client (PRD §11).
 *
 * One connection per *server*, never per student: "there is no live MCP
 * connection per student and no per-session state to lose on restart". The
 * catalogue is shared, the negotiation happens once, and what varies per
 * classroom is filtering — which happens above this module, against the
 * allowlist, not by talking to a different server.
 *
 * Nothing here knows a student exists, which is the shape §11 asks for: "no MCP
 * server may hold privileges over application data, and no student credential is
 * ever passed into a tool call".
 */

/**
 * Where an elicitation answer travels on the retry.
 *
 * §11 prescribes the behaviour — "the original request is retried with the
 * responses attached" — without pinning a wire key, so this is Setun's, sent
 * inside `_meta` where MCP puts everything a server may ignore safely.
 */
export const ELICITATION_META_KEY = "setun/elicitation";

export interface ToolCallInput {
  readonly name: string;
  readonly arguments: Record<string, unknown>;
  /** Answers to a previous interim result, attached to the retry (§11). */
  readonly elicitationResponse?: Record<string, unknown>;
  readonly signal?: AbortSignal;
}

interface Connection {
  readonly transport: StreamableHttpTransport;
  outcome: NegotiationOutcome;
}

export class McpClient {
  readonly #servers: ReadonlyMap<string, McpServerConfig>;
  readonly #connections = new Map<string, Connection>();
  readonly #catalogue: ToolCatalogue;
  readonly #env: CredentialEnvironment;
  readonly #fetch?: typeof globalThis.fetch;

  constructor(
    servers: readonly McpServerConfig[],
    options: {
      env?: CredentialEnvironment;
      catalogue?: ToolCatalogue;
      fetch?: typeof globalThis.fetch;
    } = {},
  ) {
    this.#servers = new Map(servers.map((server) => [server.key, server]));
    this.#catalogue = options.catalogue ?? toolCatalogue;
    this.#env = options.env ?? {};
    this.#fetch = options.fetch;
  }

  get serverKeys(): string[] {
    return [...this.#servers.keys()];
  }

  server(key: string): McpServerConfig | undefined {
    return this.#servers.get(key);
  }

  /** Negotiate with a server, or return what was already negotiated. */
  async probe(key: string, signal?: AbortSignal): Promise<NegotiationOutcome> {
    return (await this.#connect(key, signal)).outcome;
  }

  /** The server's tools, from the shared cache when it is still fresh (§11). */
  async listTools(key: string, signal?: AbortSignal): Promise<readonly CatalogueEntry[]> {
    const connection = await this.#connect(key, signal);

    return this.#catalogue.list({
      serverKey: key,
      hints: connection.outcome.hints,
      sessionId: connection.transport.sessionId,
      fetcher: async () => {
        const { result } = await this.#withSession(key, (transport) =>
          transport.request("tools/list", {}, signal),
        );
        return readToolList(result);
      },
    });
  }

  /**
   * Execute one tool call.
   *
   * The permission decision has already been made by the caller: this module
   * runs what it is given and normalises what comes back, including an interim
   * result asking the student for input (§11).
   */
  async callTool(key: string, input: ToolCallInput): Promise<McpToolResult> {
    const server = this.#require(key);
    await this.#connect(key, input.signal);

    const { arguments: safeArguments, headers } = filterParameterHeaders(
      input.arguments,
      server.parameterHeaderAllowlist,
    );

    const params: Record<string, unknown> = {
      name: input.name,
      arguments: safeArguments,
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
      ...(input.elicitationResponse
        ? { _meta: { [ELICITATION_META_KEY]: input.elicitationResponse } }
        : {}),
    };

    const { result } = await this.#withSession(key, (transport) =>
      transport.request("tools/call", params, input.signal),
    );

    return normaliseToolResult(result);
  }

  #require(key: string): McpServerConfig {
    const server = this.#servers.get(key);
    if (!server) throw new McpError("not-found", `no configured server '${key}'`);
    return server;
  }

  async #connect(key: string, signal?: AbortSignal): Promise<Connection> {
    const existing = this.#connections.get(key);
    if (existing) return existing;

    const server = this.#require(key);
    const transport = new StreamableHttpTransport({
      url: server.url,
      headers: server.headers,
      credential: resolveCredential(server, this.#env),
      fetch: this.#fetch,
    });

    const outcome = await negotiate(transport, signal);
    const connection: Connection = { transport, outcome };
    this.#connections.set(key, connection);
    return connection;
  }

  /**
   * Run an exchange, re-handshaking once if a legacy session has expired.
   *
   * The transport reports the expiry but cannot repair it — only negotiation
   * knows which handshake this server speaks (§11).
   */
  async #withSession<T>(
    key: string,
    exchange: (transport: StreamableHttpTransport) => Promise<T>,
  ): Promise<T> {
    const connection = await this.#connect(key);

    try {
      return await exchange(connection.transport);
    } catch (cause) {
      const expired =
        cause instanceof McpError &&
        cause.kind === "invalid-request" &&
        !connection.transport.sessionId;
      if (!expired) throw cause;

      this.#connections.delete(key);
      this.#catalogue.invalidate(key);
      const renewed = await this.#connect(key);
      return exchange(renewed.transport);
    }
  }
}

/**
 * Separate the headers a tool's parameters tried to set from the arguments (§11).
 *
 * "Header injection derived from tool parameters is disabled or strictly
 * allowlisted per server." The allowlist defaults to empty, so the behaviour is
 * off unless an operator turned it on in reviewable configuration — and the
 * configuration schema already refuses to allowlist an authentication header.
 */
export function filterParameterHeaders(
  args: Record<string, unknown>,
  allowlist: readonly string[],
): { arguments: Record<string, unknown>; headers: Record<string, string> } {
  const { _headers, ...rest } = args;
  const headers: Record<string, string> = {};

  if (_headers && typeof _headers === "object") {
    const allowed = new Set(allowlist.map((name) => name.toLowerCase()));
    for (const [name, value] of Object.entries(_headers as Record<string, unknown>)) {
      if (allowed.has(name.toLowerCase())) headers[name.toLowerCase()] = String(value);
    }
  }

  return { arguments: rest, headers };
}
