/**
 * Legacy session semantics (PRD §11).
 *
 * The current revision is stateless — "there is no live MCP connection per
 * student and no per-session state to lose on restart" — but the revisions
 * before it issue a session identifier on the handshake and expect it back on
 * every subsequent request, expiring it server-side without warning.
 *
 * That difference is absorbed here, at the transport edge, so the catalogue and
 * the loop never learn that sessions exist.
 */

export const SESSION_HEADER = "mcp-session-id";

/** The identifier a handshake response issued, if this revision issues one. */
export function readSessionId(headers: Headers): string | null {
  return headers.get(SESSION_HEADER);
}

/** Add the session identifier to an outgoing request, when one is held. */
export function withSessionHeader(
  headers: Record<string, string>,
  sessionId: string | null,
): Record<string, string> {
  return sessionId ? { ...headers, [SESSION_HEADER]: sessionId } : headers;
}

/**
 * Whether a response means "your session is gone, start again".
 *
 * A legacy server answers an expired session with 404 rather than an error
 * object, so the status is the only signal. The caller re-handshakes once; a
 * second 404 is a real failure.
 */
export function isExpiredSession(status: number, sessionId: string | null): boolean {
  return status === 404 && sessionId !== null;
}
