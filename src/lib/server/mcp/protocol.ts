/**
 * JSON-RPC shapes and error normalisation for MCP (PRD §11).
 *
 * Everything above the transport speaks the types here; nothing above it sees a
 * numeric code, a raw envelope, or the difference between protocol revisions.
 */

export interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id: number | string;
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

export interface JsonRpcNotification {
  readonly jsonrpc: "2.0";
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

export interface JsonRpcError {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

export interface JsonRpcResponse {
  readonly jsonrpc: "2.0";
  readonly id: number | string | null;
  readonly result?: unknown;
  readonly error?: JsonRpcError;
}

/**
 * The failure kinds Setun distinguishes.
 *
 * Everything the loop needs to decide with, and nothing more: a student sees a
 * friendly refusal either way, and an operator reads the detail in the log.
 */
export type McpErrorKind =
  | "method-not-found"
  | "invalid-params"
  | "invalid-request"
  | "not-found"
  | "unauthorised"
  | "cancelled"
  | "server-error";

export class McpError extends Error {
  readonly kind: McpErrorKind;
  /** Operator-facing. Logged; never serialised toward a browser (§21). */
  readonly detail: string;

  constructor(kind: McpErrorKind, detail: string) {
    super(`mcp ${kind}`);
    this.name = "McpError";
    this.kind = kind;
    this.detail = detail;
  }
}
