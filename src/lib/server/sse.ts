/**
 * Server-sent event framing for upstream responses (PRD §9, §11).
 *
 * Two domains speak SSE upstream — both gateway dialects, and the MCP
 * Streamable HTTP transport — so the framing is parsed once here and each
 * caller interprets only its own payloads. It sits beside them rather than
 * inside either: a second audience of importers is exactly when the splitting
 * principle asks for a move (§6.1).
 */

export interface UpstreamSseEvent {
  /** The `event:` field. Absent in the OpenAI dialect, significant in the Anthropic one. */
  readonly event?: string;
  readonly data: string;
}

/**
 * Parse an SSE byte stream into events.
 *
 * Chunk boundaries fall wherever the network puts them, so bytes are decoded
 * with a streaming decoder and held in a buffer until a record separator
 * arrives — a multi-byte character split across two chunks would otherwise
 * decode as replacement characters, and Danish text hits that constantly.
 */
export async function* parseSseStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<UpstreamSseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Records are separated by a blank line; tolerate CRLF from any proxy.
      let separator = findSeparator(buffer);
      while (separator) {
        const record = buffer.slice(0, separator.index);
        buffer = buffer.slice(separator.index + separator.length);

        const parsed = parseRecord(record);
        if (parsed) yield parsed;

        separator = findSeparator(buffer);
      }
    }

    const trailing = parseRecord(buffer);
    if (trailing) yield trailing;
  } finally {
    reader.releaseLock();
  }
}

function findSeparator(buffer: string): { index: number; length: number } | null {
  const lf = buffer.indexOf("\n\n");
  const crlf = buffer.indexOf("\r\n\r\n");

  if (lf === -1 && crlf === -1) return null;
  if (crlf !== -1 && (lf === -1 || crlf < lf)) return { index: crlf, length: 4 };
  return { index: lf, length: 2 };
}

function parseRecord(record: string): UpstreamSseEvent | null {
  let event: string | undefined;
  const dataLines: string[] = [];

  for (const rawLine of record.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (line.length === 0 || line.startsWith(":")) continue;

    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    // A single leading space after the colon is part of the framing, not the value.
    const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");

    if (field === "event") event = value;
    else if (field === "data") dataLines.push(value);
  }

  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join("\n") };
}
