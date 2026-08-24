import { type JsonRpcError, McpError, type McpErrorKind } from "../protocol";

/**
 * Error-code normalisation across revisions (PRD §11).
 *
 * "Compatibility handling covers… both the old and renumbered error-code
 * ranges." Two bands arrive here and one union leaves, so nothing above the
 * transport branches on which revision answered.
 */

/**
 * The JSON-RPC codes that are stable across every MCP revision.
 *
 * These come from JSON-RPC 2.0 itself rather than from MCP, which is why they
 * did not move when MCP renumbered its own.
 */
const JSON_RPC_CODES: Readonly<Record<number, McpErrorKind>> = {
  [-32700]: "invalid-request", // parse error
  [-32600]: "invalid-request",
  [-32601]: "method-not-found",
  [-32602]: "invalid-params",
  [-32603]: "server-error",
};

/**
 * The legacy application band.
 *
 * JSON-RPC reserves −32099…−32000 for "implementation-defined server errors",
 * and the pre-2026 MCP revisions put their own codes there — `-32002` for a
 * resource that does not exist, `-32001` for a cancelled request. The current
 * revision renumbered them out of the reserved band, so a code *outside*
 * −32768…−32000 is read as an application code from the current revision
 * (§11: "both the old and renumbered error-code ranges").
 *
 * Rather than hard-code numbers from a revision this repository cannot verify,
 * the normaliser classifies by band and maps the two legacy codes that are
 * documented. An unrecognised code in either band is a server error, which is
 * what the loop would do with it anyway.
 */
const LEGACY_APPLICATION_CODES: Readonly<Record<number, McpErrorKind>> = {
  [-32002]: "not-found",
  [-32001]: "cancelled",
};

const RESERVED_BAND_START = -32768;
const RESERVED_BAND_END = -32000;

/** Whether a code sits in the JSON-RPC reserved band used by the legacy revisions. */
export function isLegacyErrorCode(code: number): boolean {
  return code >= RESERVED_BAND_START && code <= RESERVED_BAND_END;
}

/**
 * Map a JSON-RPC error onto an internal kind.
 *
 * Two bands, one union: nothing above the transport branches on a revision.
 */
export function normaliseError(error: JsonRpcError): McpError {
  const stable = JSON_RPC_CODES[error.code];
  if (stable) return new McpError(stable, `${error.code}: ${error.message}`);

  if (isLegacyErrorCode(error.code)) {
    const legacy = LEGACY_APPLICATION_CODES[error.code] ?? "server-error";
    return new McpError(legacy, `${error.code}: ${error.message}`);
  }

  // The renumbered band. Application codes carry their meaning in the message
  // rather than in the number, so the kind is decided by what the server said
  // it could not do, and the detail keeps the original for the log.
  return new McpError(kindFromMessage(error.message), `${error.code}: ${error.message}`);
}

function kindFromMessage(message: string): McpErrorKind {
  const text = message.toLowerCase();
  if (text.includes("not found") || text.includes("unknown tool")) return "not-found";
  if (text.includes("unauthor") || text.includes("forbidden")) return "unauthorised";
  if (text.includes("cancel")) return "cancelled";
  return "server-error";
}
