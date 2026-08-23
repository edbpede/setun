import type { GatewayEvent } from "$lib/server/gateway/events";

/**
 * Client-side SSE consumption (PRD §6, §10).
 *
 * `EventSource` cannot issue a POST and cannot carry a request body, and sending
 * a message is a POST whose response streams events — so the stream is read off
 * `fetch` and parsed here. The same reader serves the resume endpoint, keeping
 * one client path to match the server's one code path.
 *
 * Types only from the server module: erased at compile time, so no server code
 * enters the bundle.
 */

export interface StreamedEvent {
  readonly seq: number;
  readonly event: GatewayEvent;
}

/** Read an SSE response body, yielding parsed events in order. */
export async function* readEventStream(
  response: Response,
  signal?: AbortSignal,
): AsyncGenerator<StreamedEvent> {
  if (!response.body) return;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      if (signal?.aborted) return;

      const { done, value } = await reader.read();
      if (done) break;

      // Streaming decode: a multi-byte character split across chunks would
      // otherwise arrive as replacement characters, and Danish text hits that.
      buffer += decoder.decode(value, { stream: true });

      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const record = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);

        const parsed = parseRecord(record);
        if (parsed) yield parsed;

        boundary = buffer.indexOf("\n\n");
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function parseRecord(record: string): StreamedEvent | null {
  let seq = -1;
  const dataLines: string[] = [];

  for (const line of record.split("\n")) {
    if (line.startsWith("id:")) seq = Number(line.slice(3).trim());
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
  }

  if (dataLines.length === 0) return null;

  try {
    return { seq, event: JSON.parse(dataLines.join("\n")) as GatewayEvent };
  } catch {
    // A truncated frame is not worth failing the whole stream over.
    return null;
  }
}
