/**
 * Fixture helpers for gateway dialect tests.
 *
 * Recorded upstream streams are replayed through a stub `fetch`, so the dialects
 * are exercised over their real parsing path — SSE framing included — without a
 * live gateway (§22).
 */

/** Frame payloads as an SSE body, the way an upstream would. */
export function sseBody(records: (string | { event: string; data: string })[]): string {
  return records
    .map((record) =>
      typeof record === "string"
        ? `data: ${record}\n\n`
        : `event: ${record.event}\ndata: ${record.data}\n\n`,
    )
    .join("");
}

export interface StubFetchCall {
  readonly url: string;
  readonly headers: Headers;
  readonly body: unknown;
}

export interface StubFetch {
  readonly fetch: typeof globalThis.fetch;
  readonly calls: StubFetchCall[];
}

/** A `fetch` that answers every request with one prepared response. */
export function stubFetch(
  responder: (call: StubFetchCall) => Response | Promise<Response>,
): StubFetch {
  const calls: StubFetchCall[] = [];

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const rawBody = init?.body;
    const call: StubFetchCall = {
      url: String(input),
      headers,
      body: typeof rawBody === "string" ? JSON.parse(rawBody) : rawBody,
    };
    calls.push(call);

    if (init?.signal?.aborted) {
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    }
    return responder(call);
  }) as typeof globalThis.fetch;

  return { fetch: fetchImpl, calls };
}

/** An SSE response, streamed one record at a time so chunk boundaries are real. */
export function streamingResponse(records: (string | { event: string; data: string })[]): Response {
  const encoder = new TextEncoder();
  const frames = records.map((record) => sseBody([record]));

  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of frames) controller.enqueue(encoder.encode(frame));
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}
