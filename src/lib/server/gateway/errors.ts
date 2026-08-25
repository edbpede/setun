/**
 * Gateway failure mapping (PRD §9, §16, §21).
 *
 * "Gateway failures produce a single student-facing message about temporary
 * unavailability. Upstream URLs, provider identifiers, OAuth errors, tokens, and
 * stack traces never reach the browser."
 *
 * So the adapter raises one error type carrying two separate things: a stable
 * code the interface turns into a localised message, and a detail string that is
 * logged and never serialised toward a browser.
 */

export type GatewayFailureCode =
  /** Anything upstream: connection refused, 5xx, malformed stream, timeout. */
  | "unavailable"
  /** The listener key was rejected — an operator misconfiguration, not a student problem. */
  | "unauthorised"
  /** The upstream declined this request specifically (bad model id, oversized context). */
  | "rejected";

export class GatewayError extends Error {
  readonly code: GatewayFailureCode;
  /** Operator-facing. Logged; never sent to the browser (§21). */
  readonly detail: string;

  constructor(code: GatewayFailureCode, detail: string) {
    super(`gateway ${code}`);
    this.name = "GatewayError";
    this.code = code;
    this.detail = detail;
  }
}

/**
 * Redaction lives in `$lib/server/logging`, and is re-exported here.
 *
 * The gateway was the first caller and is still the loudest one, but the MCP
 * registry, the agent loop and the job scheduler log failures too — one copy of
 * the patterns, four importers (§16, §21, §6.1).
 */
export { redactCredentials, redactHeaders } from "../logging";

/** Map an upstream HTTP status onto a failure code. */
export function failureCodeForStatus(status: number): GatewayFailureCode {
  if (status === 401 || status === 403) return "unauthorised";
  if (status === 400 || status === 404 || status === 413 || status === 422) return "rejected";
  return "unavailable";
}
