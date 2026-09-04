import { describe, expect, it } from "bun:test";
import { GatewayAdapter } from "./adapter";
import { GatewayError } from "./errors";
import type { GatewayEvent } from "./events";
import { sseBody, streamingResponse, stubFetch } from "./testing";

/**
 * Dialect event normalisation, usage extraction and error mapping
 * (plan 1.4, PRD §9, §10, §21, §22).
 */

const BASE_URL = "http://cpa:8317";
const LISTENER_KEY = "test-listener-key";

function adapterOver(responder: Parameters<typeof stubFetch>[0]) {
  const stub = stubFetch(responder);
  const adapter = new GatewayAdapter({
    baseUrl: BASE_URL,
    listenerKey: LISTENER_KEY,
    fetch: stub.fetch,
  });
  return { adapter, stub };
}

async function collect(events: AsyncGenerator<GatewayEvent>): Promise<GatewayEvent[]> {
  const out: GatewayEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

const request = {
  model: "gpt-test",
  messages: [
    { role: "system" as const, content: "You are helpful." },
    { role: "user" as const, content: "Hej" },
  ],
};

/** A recorded OpenAI-compatible chat-completions stream. */
const OPENAI_STREAM = [
  JSON.stringify({ choices: [{ delta: { role: "assistant" } }] }),
  JSON.stringify({ choices: [{ delta: { content: "Hej" } }] }),
  JSON.stringify({ choices: [{ delta: { content: " med" } }] }),
  JSON.stringify({ choices: [{ delta: { content: " dig" } }] }),
  JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] }),
  JSON.stringify({ choices: [], usage: { prompt_tokens: 25, completion_tokens: 7 } }),
  "[DONE]",
];

/** The opening record of an Anthropic stream, which carries the billed input count. */
const ANTHROPIC_MESSAGE_START = {
  event: "message_start",
  data: JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 31 } } }),
};

/** A recorded Anthropic-native Messages stream. */
const ANTHROPIC_STREAM = [
  ANTHROPIC_MESSAGE_START,
  {
    event: "content_block_start",
    data: JSON.stringify({
      type: "content_block_start",
      content_block: { type: "text", text: "" },
    }),
  },
  {
    event: "content_block_delta",
    data: JSON.stringify({ type: "content_block_delta", delta: { text: "Hej" } }),
  },
  {
    event: "content_block_delta",
    data: JSON.stringify({ type: "content_block_delta", delta: { text: " med dig" } }),
  },
  {
    event: "message_delta",
    data: JSON.stringify({ type: "message_delta", usage: { output_tokens: 9 } }),
  },
  { event: "message_stop", data: JSON.stringify({ type: "message_stop" }) },
];

/**
 * Collect what a stream yields before it fails, alongside the failure.
 *
 * A dialect that prices a cancelled read has to be judged on what it emitted on
 * the way out, which `collect` discards by rethrowing.
 */
async function collectUntilThrow(
  events: AsyncGenerator<GatewayEvent>,
): Promise<{ events: GatewayEvent[]; error: unknown }> {
  const out: GatewayEvent[] = [];
  try {
    for await (const event of events) out.push(event);
  } catch (error) {
    return { events: out, error };
  }
  throw new Error("expected the stream to fail");
}

/**
 * A 200 whose body fails before it delivers anything — the provider accepted the
 * request and started work, and the read was cancelled during the wait.
 */
function acceptedThenCancelled(records: (string | { event: string; data: string })[]): Response {
  const encoder = new TextEncoder();
  const frames = records.map((record) => sseBody([record]));

  return new Response(
    new ReadableStream<Uint8Array>({
      start(stream) {
        for (const frame of frames) stream.enqueue(encoder.encode(frame));
      },
      // Erroring on the pull rather than at the start lets the prepared records
      // be read first, so a test can place the cancellation exactly.
      pull(stream) {
        stream.error(Object.assign(new Error("aborted"), { name: "AbortError" }));
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

describe("both dialects normalise to one event stream", () => {
  it("emits identical text deltas regardless of dialect", async () => {
    const openai = adapterOver(() => streamingResponse(OPENAI_STREAM));
    const anthropic = adapterOver(() => streamingResponse(ANTHROPIC_STREAM));

    const openaiEvents = await collect(openai.adapter.streamChat("openai", request));
    const anthropicEvents = await collect(anthropic.adapter.streamChat("anthropic", request));

    const textOf = (events: GatewayEvent[]) =>
      events
        .filter((e): e is Extract<GatewayEvent, { type: "text-delta" }> => e.type === "text-delta")
        .map((e) => e.text)
        .join("");

    expect(textOf(openaiEvents)).toBe("Hej med dig");
    expect(textOf(anthropicEvents)).toBe("Hej med dig");

    // Nothing above the adapter can tell which dialect answered (§9). Chunk
    // boundaries are not part of that claim — how a provider splits its deltas
    // is its own business, and the fixtures deliberately split differently.
    // What must match is the sequence of event *kinds*.
    const shapeOf = (events: GatewayEvent[]) =>
      events.map((e) => e.type).filter((type, i, all) => type !== all[i - 1]);

    expect(shapeOf(openaiEvents)).toEqual(["text-delta", "usage"]);
    expect(shapeOf(anthropicEvents)).toEqual(shapeOf(openaiEvents));
  });

  it("yields no provider-specific fields on any event", async () => {
    const { adapter } = adapterOver(() => streamingResponse(OPENAI_STREAM));

    for (const event of await collect(adapter.streamChat("openai", request))) {
      expect(Object.keys(event).every((key) => !key.includes("_"))).toBe(true);
    }
  });
});

describe("openai dialect", () => {
  it("requests a stream with usage included", async () => {
    const { adapter, stub } = adapterOver(() => streamingResponse(OPENAI_STREAM));
    await collect(adapter.streamChat("openai", request));

    expect(stub.calls[0].url).toBe(`${BASE_URL}/v1/chat/completions`);
    expect(stub.calls[0].body).toMatchObject({
      model: "gpt-test",
      stream: true,
      stream_options: { include_usage: true },
    });
  });

  it("authenticates with the listener key", async () => {
    const { adapter, stub } = adapterOver(() => streamingResponse(OPENAI_STREAM));
    await collect(adapter.streamChat("openai", request));

    expect(stub.calls[0].headers.get("authorization")).toBe(`Bearer ${LISTENER_KEY}`);
  });

  it("reports gateway usage verbatim and unflagged", async () => {
    const { adapter } = adapterOver(() => streamingResponse(OPENAI_STREAM));
    const events = await collect(adapter.streamChat("openai", request));

    expect(events.at(-1)).toEqual({
      type: "usage",
      inputTokens: 25,
      outputTokens: 7,
      estimated: false,
      finishReason: "stop",
    });
  });

  /**
   * Without this a response cut at the provider's own output ceiling looks
   * exactly like one that finished its sentence, and the pupil is shown a
   * half-written answer with nothing to say so (§10).
   */
  it("reports a length stop, so the loop can call the answer truncated", async () => {
    const { adapter } = adapterOver(() =>
      streamingResponse([
        JSON.stringify({ choices: [{ delta: { content: "Halv" } }] }),
        JSON.stringify({ choices: [{ delta: {}, finish_reason: "length" }] }),
        JSON.stringify({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 1 } }),
        "[DONE]",
      ]),
    );
    const events = await collect(adapter.streamChat("openai", request));

    expect(events.at(-1)).toMatchObject({ type: "usage", finishReason: "length" });
  });

  it("reports a tool-call stop under one name, whichever the provider used", async () => {
    for (const raw of ["tool_calls", "function_call"]) {
      const { adapter } = adapterOver(() =>
        streamingResponse([
          JSON.stringify({ choices: [{ delta: {}, finish_reason: raw }] }),
          JSON.stringify({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 1 } }),
          "[DONE]",
        ]),
      );
      const events = await collect(adapter.streamChat("openai", request));

      expect(events.at(-1)).toMatchObject({ type: "usage", finishReason: "tool-calls" });
    }
  });

  it("reads an unfamiliar finish reason as a clean stop, never as a ceiling", async () => {
    const { adapter } = adapterOver(() =>
      streamingResponse([
        JSON.stringify({ choices: [{ delta: {}, finish_reason: "content_filter" }] }),
        JSON.stringify({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 1 } }),
        "[DONE]",
      ]),
    );
    const events = await collect(adapter.streamChat("openai", request));

    expect(events.at(-1)).toMatchObject({ type: "usage", finishReason: "stop" });
  });

  it("lists models", async () => {
    const { adapter } = adapterOver(
      () => new Response(JSON.stringify({ data: [{ id: "a" }, { id: "b" }, {}] })),
    );

    expect(await adapter.listModels("openai")).toEqual([{ id: "a" }, { id: "b" }]);
  });
});

describe("anthropic dialect", () => {
  it("hoists system messages to the top-level field", async () => {
    const { adapter, stub } = adapterOver(() => streamingResponse(ANTHROPIC_STREAM));
    await collect(adapter.streamChat("anthropic", request));

    const body = stub.calls[0].body as { system?: string; messages: { role: string }[] };
    expect(stub.calls[0].url).toBe(`${BASE_URL}/v1/messages`);
    expect(body.system).toBe("You are helpful.");
    expect(body.messages.every((m) => m.role !== "system")).toBe(true);
  });

  it("combines usage split across message_start and message_delta", async () => {
    const { adapter } = adapterOver(() => streamingResponse(ANTHROPIC_STREAM));
    const events = await collect(adapter.streamChat("anthropic", request));

    expect(events.at(-1)).toEqual({
      type: "usage",
      inputTokens: 31,
      outputTokens: 9,
      estimated: false,
    });
  });

  /**
   * The old ceiling was 4 096 tokens, which cut a long artifact in half and
   * reported it as a clean stop (§10).
   */
  it("asks for a ceiling high enough not to truncate ordinary work", async () => {
    const { adapter, stub } = adapterOver(() => streamingResponse(ANTHROPIC_STREAM));
    await collect(adapter.streamChat("anthropic", request));

    expect(stub.calls[0].body).toMatchObject({ max_tokens: 32_000 });
  });

  it("honours an explicit ceiling over the default", async () => {
    const { adapter, stub } = adapterOver(() => streamingResponse(ANTHROPIC_STREAM));
    await collect(adapter.streamChat("anthropic", { ...request, maxOutputTokens: 1_024 }));

    expect(stub.calls[0].body).toMatchObject({ max_tokens: 1_024 });
  });

  it("maps stop_reason onto the same finish reasons the other dialect reports", async () => {
    const cases = [
      ["max_tokens", "length"],
      ["tool_use", "tool-calls"],
      ["end_turn", "stop"],
    ] as const;

    for (const [raw, expected] of cases) {
      const { adapter } = adapterOver(() =>
        streamingResponse([
          ANTHROPIC_MESSAGE_START,
          {
            event: "message_delta",
            data: JSON.stringify({
              type: "message_delta",
              delta: { stop_reason: raw },
              usage: { output_tokens: 9 },
            }),
          },
        ]),
      );
      const events = await collect(adapter.streamChat("anthropic", request));

      expect(events.at(-1)).toMatchObject({ type: "usage", finishReason: expected });
    }
  });

  it("maps an upstream error event to a gateway failure", async () => {
    const { adapter } = adapterOver(() =>
      streamingResponse([
        {
          event: "error",
          data: JSON.stringify({ type: "error", error: { message: "overloaded" } }),
        },
      ]),
    );

    expect(collect(adapter.streamChat("anthropic", request))).rejects.toThrow(GatewayError);
  });
});

describe("estimated usage fallback", () => {
  it("estimates at ~4 chars per token and flags it when the gateway reports none", async () => {
    const { adapter } = adapterOver(() =>
      streamingResponse([
        JSON.stringify({ choices: [{ delta: { content: "12345678" } }] }),
        "[DONE]",
      ]),
    );

    const events = await collect(adapter.streamChat("openai", request));
    const usage = events.at(-1);

    expect(usage).toMatchObject({ type: "usage", estimated: true });
    // 8 characters of completion at 4 chars/token.
    expect(usage).toMatchObject({ outputTokens: 2 });
  });

  it("never records usage as zero for a response that produced text", async () => {
    const { adapter } = adapterOver(() =>
      streamingResponse([JSON.stringify({ choices: [{ delta: { content: "x" } }] }), "[DONE]"]),
    );

    const usage = (await collect(adapter.streamChat("openai", request))).at(-1);

    expect(usage).toMatchObject({ type: "usage", estimated: true });
    expect((usage as { inputTokens: number }).inputTokens).toBeGreaterThan(0);
    expect((usage as { outputTokens: number }).outputTokens).toBeGreaterThan(0);
  });

  it("estimates the missing side when the gateway reports only input", async () => {
    const { adapter } = adapterOver(() =>
      streamingResponse([
        JSON.stringify({ choices: [{ delta: { content: "abcdefgh" } }] }),
        JSON.stringify({ choices: [], usage: { prompt_tokens: 40 } }),
        "[DONE]",
      ]),
    );

    const usage = (await collect(adapter.streamChat("openai", request))).at(-1);

    expect(usage).toEqual({
      type: "usage",
      inputTokens: 40,
      outputTokens: 2,
      estimated: true,
    });
  });
});

describe("error mapping", () => {
  const cases: { status: number; code: string }[] = [
    { status: 401, code: "unauthorised" },
    { status: 403, code: "unauthorised" },
    { status: 400, code: "rejected" },
    { status: 404, code: "rejected" },
    { status: 500, code: "unavailable" },
    { status: 502, code: "unavailable" },
    { status: 503, code: "unavailable" },
  ];

  for (const { status, code } of cases) {
    it(`maps upstream ${status} to ${code}`, async () => {
      const { adapter } = adapterOver(() => new Response("upstream detail", { status }));

      await expect(collect(adapter.streamChat("openai", request))).rejects.toMatchObject({
        name: "GatewayError",
        code,
      });
    });
  }

  it("maps a transport failure to unavailable", async () => {
    const { adapter } = adapterOver(() => {
      throw new TypeError("connect ECONNREFUSED 172.20.0.3:8317");
    });

    await expect(collect(adapter.streamChat("openai", request))).rejects.toMatchObject({
      code: "unavailable",
    });
  });

  it("keeps the upstream body out of the error message, retaining it as detail", async () => {
    const upstreamBody = "https://generativelanguage.googleapis.com refused: oauth token expired";
    const { adapter } = adapterOver(() => new Response(upstreamBody, { status: 502 }));

    try {
      await collect(adapter.streamChat("openai", request));
      throw new Error("expected a gateway failure");
    } catch (error) {
      const failure = error as GatewayError;
      // `message` is what a careless handler would surface; it carries nothing (§21).
      expect(failure.message).toBe("gateway unavailable");
      expect(failure.message).not.toContain("googleapis");
      // The detail is for the operator log, and does hold the upstream text.
      expect(failure.detail).toContain("oauth token expired");
    }
  });

  it("propagates an abort as an abort, not as a gateway failure", async () => {
    const controller = new AbortController();
    controller.abort();
    const { adapter } = adapterOver(() => streamingResponse(OPENAI_STREAM));

    await expect(
      collect(adapter.streamChat("openai", { ...request, signal: controller.signal })),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rejects a malformed upstream chunk", async () => {
    const { adapter } = adapterOver(() => streamingResponse(["{not json"]));

    await expect(collect(adapter.streamChat("openai", request))).rejects.toMatchObject({
      code: "unavailable",
    });
  });
});

describe("a cancelled read is still priced from the moment upstream accepted", () => {
  /**
   * The regression (PRD §10): a pupil who pressed Stop while the model was still
   * thinking — accepted request, no event yet — left the read throwing before
   * any usage was emitted, so the turn was accounted as free. The prompt was
   * billed the moment upstream took the request, and a pupil may press Stop as
   * often as they like.
   */
  it("prices a pre-event abort in the openai dialect", async () => {
    const { adapter } = adapterOver(() => acceptedThenCancelled([]));

    const { events, error } = await collectUntilThrow(adapter.streamChat("openai", request));

    expect((error as Error).name).toBe("AbortError");
    const usage = events.filter((event) => event.type === "usage");
    expect(usage).toHaveLength(1);
    const [only] = usage;
    if (only?.type !== "usage") throw new Error("expected a usage event");
    expect(only.estimated).toBe(true);
    // The prompt was sent and billed; nothing was generated for the pupil to be
    // charged output for.
    expect(only.inputTokens).toBeGreaterThan(0);
    expect(only.outputTokens).toBe(0);
  });

  it("keeps the reported input figure on a pre-event abort in the anthropic dialect", async () => {
    // `message_start` carries the real input count, so this dialect knows the
    // billed figure before it has produced a word.
    const { adapter } = adapterOver(() => acceptedThenCancelled([ANTHROPIC_MESSAGE_START]));

    const { events, error } = await collectUntilThrow(adapter.streamChat("anthropic", request));

    expect((error as Error).name).toBe("AbortError");
    const usage = events.filter((event) => event.type === "usage");
    expect(usage).toHaveLength(1);
    const [only] = usage;
    if (only?.type !== "usage") throw new Error("expected a usage event");
    expect(only.inputTokens).toBe(31);
  });

  it("emits exactly one usage event when the abort lands mid-stream", async () => {
    const { adapter } = adapterOver(() =>
      acceptedThenCancelled([JSON.stringify({ choices: [{ delta: { content: "Hej" } }] })]),
    );

    const { events } = await collectUntilThrow(adapter.streamChat("openai", request));

    expect(events.filter((event) => event.type === "usage")).toHaveLength(1);
  });

  it("prices nothing when upstream never accepted the request", async () => {
    // A refused or unreachable request cost the pupil nothing, and charging one
    // would be a worse fault than the gap the pricing above closed.
    for (const responder of [
      () => new Response("no such model", { status: 404 }),
      () => {
        throw new TypeError("connect ECONNREFUSED 172.20.0.3:8317");
      },
    ]) {
      const { adapter } = adapterOver(responder);
      const { events } = await collectUntilThrow(adapter.streamChat("openai", request));
      expect(events).toEqual([]);
    }
  });
});
