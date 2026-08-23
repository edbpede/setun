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

/** Values that look like credentials are replaced before anything is logged (§16, §21). */
const REDACTION = "[redacted]";

const SENSITIVE_HEADERS = new Set(["authorization", "x-api-key", "proxy-authorization", "cookie"]);

/**
 * Redact credential-shaped substrings from arbitrary text.
 *
 * Applied to every upstream detail before it is logged, because an upstream
 * error body can quote the request that produced it — including its headers.
 */
export function redactCredentials(text: string): string {
  return (
    text
      // `Authorization: Bearer sk-…` and friends, header-style.
      .replace(
        /\b(authorization|x-api-key|proxy-authorization|cookie)\s*[:=]\s*\S+/gi,
        `$1: ${REDACTION}`,
      )
      // Bare bearer tokens anywhere in a message.
      .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, `Bearer ${REDACTION}`)
      // Provider key prefixes quoted in a body.
      .replace(/\b(sk|pk|api)[-_][A-Za-z0-9._-]{8,}/gi, REDACTION)
  );
}

/** Headers safe to log: sensitive ones are replaced, not omitted, so their presence still shows. */
export function redactHeaders(headers: Headers | Record<string, string>): Record<string, string> {
  const entries = headers instanceof Headers ? [...headers.entries()] : Object.entries(headers);
  return Object.fromEntries(
    entries.map(([key, value]) => [
      key,
      SENSITIVE_HEADERS.has(key.toLowerCase()) ? REDACTION : value,
    ]),
  );
}

/** Map an upstream HTTP status onto a failure code. */
export function failureCodeForStatus(status: number): GatewayFailureCode {
  if (status === 401 || status === 403) return "unauthorised";
  if (status === 400 || status === 404 || status === 413 || status === 422) return "rejected";
  return "unavailable";
}
