import { parseSseStream } from "../sse";
import { normaliseError } from "./legacy/errors";
import { isExpiredSession, readSessionId, withSessionHeader } from "./legacy/session";
import {
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
  McpError,
} from "./protocol";

/**
 * The MCP transport (PRD §11).
 *
 * "Streamable HTTP only. The deprecated HTTP+SSE transport is not implemented.
 * Stdio servers, if ever needed, run as separate pinned containers on the
 * internal network and are addressed over HTTP — educator-supplied stdio
 * configuration would amount to remote code execution on the host and is not
 * supported."
 *
 * One POST per request. The server may answer with a single JSON object or with
 * an event stream carrying the same response among its frames; both are read
 * here, and the caller receives a result either way.
 */

export interface McpTransportOptions {
  readonly url: string;
  /** Static headers from reviewable configuration (§11). */
  readonly headers?: Readonly<Record<string, string>>;
  /** Resolved from an environment variable name, never from the database (§11). */
  readonly credential?: string | null;
  /** Sent once negotiated, so a server knows which revision it is being spoken. */
  readonly protocolVersion?: string | null;
  /** Held only for revisions with session semantics; null for the stateless ones. */
  sessionId?: string | null;
  readonly fetch?: typeof globalThis.fetch;
}

export interface McpRequestResult {
  readonly result: unknown;
  /** A session the server issued or refreshed on this exchange, if any. */
  readonly sessionId: string | null;
}

export const PROTOCOL_VERSION_HEADER = "mcp-protocol-version";

/** How long a single MCP exchange may take before it is abandoned. */
const REQUEST_TIMEOUT_MS = 30_000;

export class StreamableHttpTransport {
  readonly #options: McpTransportOptions;
  readonly #fetch: typeof globalThis.fetch;
  #sessionId: string | null;
  #nextId = 1;

  constructor(options: McpTransportOptions) {
    this.#options = options;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#sessionId = options.sessionId ?? null;
  }

  get sessionId(): string | null {
    return this.#sessionId;
  }

  /**
   * Issue one request and return its result.
   *
   * A legacy server whose session has expired answers 404; the caller of this
   * transport re-handshakes rather than this method guessing at one, because
   * only the negotiation module knows which handshake this server speaks.
   */
  async request(
    method: string,
    params?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<McpRequestResult> {
    const payload: JsonRpcRequest = { jsonrpc: "2.0", id: this.#nextId++, method, params };
    const response = await this.#send(payload, signal);

    if (isExpiredSession(response.status, this.#sessionId)) {
      this.#sessionId = null;
      throw new McpError("invalid-request", "session expired");
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new McpError(
        response.status === 401 || response.status === 403 ? "unauthorised" : "server-error",
        `status ${response.status}: ${detail.slice(0, 500)}`,
      );
    }

    const issued = readSessionId(response.headers);
    if (issued) this.#sessionId = issued;

    const envelope = await readEnvelope(response, payload.id);
    if (envelope.error) throw normaliseError(envelope.error);

    return { result: envelope.result, sessionId: this.#sessionId };
  }

  /** Fire-and-forget: the legacy handshake needs one, and nothing else does. */
  async notify(method: string, params?: Record<string, unknown>): Promise<void> {
    const payload: JsonRpcNotification = { jsonrpc: "2.0", method, params };
    const response = await this.#send(payload);
    // Drain so the connection can be reused; the body carries nothing.
    await response.body?.cancel().catch(() => {});
  }

  async #send(payload: unknown, signal?: AbortSignal): Promise<Response> {
    const headers = withSessionHeader(
      {
        "content-type": "application/json",
        // Both response shapes are acceptable, which is what makes this one
        // transport rather than two.
        accept: "application/json, text/event-stream",
        ...this.#options.headers,
        ...(this.#options.protocolVersion
          ? { [PROTOCOL_VERSION_HEADER]: this.#options.protocolVersion }
          : {}),
        ...(this.#options.credential
          ? { authorization: `Bearer ${this.#options.credential}` }
          : {}),
      },
      this.#sessionId,
    );

    // A server that never answers must not hold a student's turn open until the
    // per-turn wall-clock cap notices (§10).
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

    try {
      return await this.#fetch(this.#options.url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: combined,
      });
    } catch (cause) {
      // A student's abort travels on; anything else is the server being absent.
      if (signal?.aborted) throw cause;
      throw new McpError(
        "server-error",
        cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause),
      );
    }
  }
}

/**
 * Read the response envelope, whichever shape the server chose.
 *
 * A stream may interleave notifications and server-initiated requests with the
 * response being waited for, so frames are matched by identifier rather than by
 * position.
 */
async function readEnvelope(
  response: Response,
  id: number | string,
): Promise<{ result?: unknown; error?: JsonRpcResponse["error"] }> {
  const contentType = response.headers.get("content-type") ?? "";

  if (!contentType.includes("text/event-stream")) {
    const body = (await response.json().catch(() => null)) as JsonRpcResponse | null;
    if (!body) throw new McpError("server-error", "malformed response body");
    return { result: body.result, error: body.error };
  }

  if (!response.body) throw new McpError("server-error", "streamed response had no body");

  for await (const frame of parseSseStream(response.body)) {
    let message: JsonRpcResponse;
    try {
      message = JSON.parse(frame.data) as JsonRpcResponse;
    } catch {
      continue;
    }
    if (message.id === id) return { result: message.result, error: message.error };
  }

  throw new McpError("server-error", "stream ended without a response");
}
