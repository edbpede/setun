/**
 * What may be written to a log, and in what shape (PRD §16, §21).
 *
 * "Application logs at normal levels contain no prompt or response content.
 * They carry internal identifiers, request identifiers, model aliases, latency,
 * status, and token counts. Credentials are redacted everywhere, including in
 * gateway headers and error paths" (§16).
 *
 * The rule is easy to state and easy to breach by accident, because the thing
 * that breaches it is almost always an error message rather than a deliberate
 * log line: an upstream 400 quotes the request that caused it, an MCP transport
 * failure quotes the URL it dialled, a stack trace quotes a file path. So every
 * error path goes through `describeCause` here rather than interpolating an
 * error directly, and `describeCause` redacts, drops the stack, and truncates.
 *
 * A shared module rather than a helper per domain: the gateway, the agent loop,
 * the MCP registry and the job scheduler all log failures, and four private
 * copies of a redaction pattern is four places for one of them to fall behind.
 */

const REDACTION = "[redacted]";

/** Headers whose value is a credential by definition; their presence still shows. */
const SENSITIVE_HEADERS = new Set(["authorization", "x-api-key", "proxy-authorization", "cookie"]);

/**
 * How much of an upstream message survives.
 *
 * Long enough to identify a failure, short enough that a body quoting a prompt
 * cannot smuggle the prompt into the log through an error path (§16).
 */
const MAX_DETAIL = 300;

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
      // Credentials embedded in a URL's userinfo, which is how an MCP transport
      // failure most often quotes one.
      .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, `$1${REDACTION}@`)
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

/**
 * One line describing a failure, fit to log.
 *
 * The error's type and message, redacted and truncated — never its stack, which
 * carries absolute paths and, in a template literal, sometimes the values that
 * built the string that threw (§21).
 */
export function describeCause(cause: unknown): string {
  const raw = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
  const redacted = redactCredentials(raw);
  return redacted.length > MAX_DETAIL ? `${redacted.slice(0, MAX_DETAIL)}…` : redacted;
}
