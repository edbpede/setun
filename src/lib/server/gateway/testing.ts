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

export interface StubFetchOptions {
  /**
   * Whether this stubbed gateway implements `/v1/responses`.
   *
   * Off by default. The OpenAI dialect prefers the Responses transport and falls
   * back to chat completions on a 404, and most tests here are about something
   * else entirely — a skill loading, a title being generated, a budget binding —
   * handing back a recorded chat-completions stream whatever is asked of them.
   * So the transport probe is answered 404 on their behalf, and deliberately not
   * recorded: it is infrastructure rather than the request under test, and
   * `calls[0]` should be the call the test made.
   *
   * Tests that are about the Responses transport set this and route on the URL
   * themselves.
   */
  readonly responses?: boolean;
}

/** A `fetch` that answers every request with one prepared response. */
export function stubFetch(
  responder: (call: StubFetchCall) => Response | Promise<Response>,
  options: StubFetchOptions = {},
): StubFetch {
  const calls: StubFetchCall[] = [];

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!options.responses && String(input).endsWith("/v1/responses")) {
      return new Response("unknown url: /v1/responses", { status: 404 });
    }

    const headers = new Headers(init?.headers);
    const rawBody = init?.body;
    const call: StubFetchCall = {
      url: String(input),
      headers,
      body: typeof rawBody === "string" ? JSON.parse(rawBody) : rawBody,
    };
    calls.push(call);

    const signal = init?.signal;
    if (signal?.aborted) {
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    }

    const response = responder(call);
    if (!signal) return response;

    // A real `fetch` rejects the moment its signal aborts, however long the
    // upstream takes. A stub that only checked at entry would let a test think
    // a timeout worked when nothing had cancelled.
    return Promise.race([
      response,
      new Promise<Response>((_, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          { once: true },
        );
      }),
    ]);
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
