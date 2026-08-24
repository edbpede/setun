import { MCP_TARGET_PROTOCOL_VERSION } from "../db/schema/mcp-server";
import { McpError } from "./protocol";
import type { StreamableHttpTransport } from "./transport";

/**
 * Version and capability negotiation (PRD §11).
 *
 * "On registration the client probes `server/discover` for version and
 * capability negotiation and falls back to the legacy handshake if that is
 * unsupported; the negotiated version is stored per server and displayed in the
 * educator panel."
 *
 * The two handshakes differ in more than their method name: the legacy one is
 * an exchange — `initialize`, then an `initialized` notification — and it is the
 * one that issues a session. That difference stops here.
 */

/** What Setun tells a server about itself. Carries nothing about any student (§16). */
const CLIENT_INFO = { name: "setun", version: "0.1" } as const;

export interface McpCapabilities {
  readonly tools: boolean;
  /** Whether the server may ask the student for input mid-call (§11). */
  readonly elicitation: boolean;
}

/**
 * Catalogue caching hints (§11).
 *
 * "Tool catalogues are fetched once, cached server-wide honouring the advertised
 * freshness and cache-scope hints." A server that advertises neither gets the
 * defaults applied by the catalogue, not a guess made here.
 */
export interface CatalogueHints {
  readonly freshnessSeconds: number | null;
  readonly scope: "server" | "session" | null;
}

export interface NegotiationOutcome {
  readonly version: string;
  /** True when the legacy handshake answered; the transport keeps a session (§11). */
  readonly legacy: boolean;
  readonly sessionId: string | null;
  readonly capabilities: McpCapabilities;
  readonly hints: CatalogueHints;
}

/**
 * Negotiate with a server, preferring the current revision.
 *
 * A server that does not know `server/discover` answers method-not-found, which
 * is the signal to fall back — not an error to report. Anything else is a real
 * failure and travels up.
 */
export async function negotiate(
  transport: StreamableHttpTransport,
  signal?: AbortSignal,
): Promise<NegotiationOutcome> {
  try {
    const { result } = await transport.request("server/discover", {}, signal);
    return readDiscovery(result, transport.sessionId);
  } catch (cause) {
    if (!(cause instanceof McpError) || cause.kind !== "method-not-found") throw cause;
  }

  return legacyHandshake(transport, signal);
}

function readDiscovery(raw: unknown, sessionId: string | null): NegotiationOutcome {
  const result = (raw ?? {}) as Record<string, unknown>;
  const capabilities = (result.capabilities ?? {}) as Record<string, unknown>;
  const cache = (result.cache ?? capabilities.cache ?? {}) as Record<string, unknown>;

  return {
    version: String(result.protocolVersion ?? MCP_TARGET_PROTOCOL_VERSION),
    legacy: false,
    sessionId,
    capabilities: {
      tools: capabilities.tools !== undefined,
      elicitation: capabilities.elicitation !== undefined,
    },
    hints: {
      freshnessSeconds: readSeconds(cache.freshnessSeconds ?? cache.maxAgeSeconds),
      scope: cache.scope === "session" ? "session" : cache.scope === "server" ? "server" : null,
    },
  };
}

/**
 * The pre-2026 handshake.
 *
 * `initialize` states the revision the client targets, the server answers with
 * the one it will speak, and the exchange is only complete once the client has
 * acknowledged — a server that is not told will refuse every subsequent call.
 */
async function legacyHandshake(
  transport: StreamableHttpTransport,
  signal?: AbortSignal,
): Promise<NegotiationOutcome> {
  const { result } = await transport.request(
    "initialize",
    {
      protocolVersion: MCP_TARGET_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    },
    signal,
  );

  await transport.notify("notifications/initialized");

  const payload = (result ?? {}) as Record<string, unknown>;
  const capabilities = (payload.capabilities ?? {}) as Record<string, unknown>;

  return {
    version: String(payload.protocolVersion ?? "unknown"),
    legacy: true,
    sessionId: transport.sessionId,
    capabilities: {
      tools: capabilities.tools !== undefined,
      elicitation: capabilities.elicitation !== undefined,
    },
    // The legacy revisions advertise no caching hints; the catalogue's own
    // default freshness applies, and the scope is per-session by construction.
    hints: { freshnessSeconds: null, scope: "session" },
  };
}

function readSeconds(value: unknown): number | null {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : null;
}
