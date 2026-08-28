import { describe, expect, it } from "bun:test";
import { GatewayAdapter } from "../gateway/adapter";
import type { GatewayEvent } from "../gateway/events";
import { streamingResponse, stubFetch } from "../gateway/testing";
import { assembleContext, runTurn } from "./loop";
import { BASE_SYSTEM_PROMPT } from "./system-prompt";

/**
 * Agent-loop termination conditions and context assembly
 * (plan 1.5, PRD §10, §22).
 */

function adapterOver(responder: Parameters<typeof stubFetch>[0]) {
  const stub = stubFetch(responder);
  return {
    adapter: new GatewayAdapter({
      baseUrl: "http://cpa:8317",
      listenerKey: "k",
      fetch: stub.fetch,
    }),
    stub,
  };
}

const path = [
  { role: "user" as const, parts: [{ type: "text" as const, text: "Hej" }] },
  { role: "assistant" as const, parts: [{ type: "text" as const, text: "Hej med dig" }] },
  { role: "user" as const, parts: [{ type: "text" as const, text: "Forklar loops" }] },
];

async function collect(events: AsyncGenerator<GatewayEvent>): Promise<GatewayEvent[]> {
  const out: GatewayEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

const OK_STREAM = [
  JSON.stringify({ choices: [{ delta: { content: "Et loop" } }] }),
  JSON.stringify({ choices: [{ delta: { content: " gentager" } }] }),
  JSON.stringify({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 4 } }),
  "[DONE]",
];

describe("assembleContext", () => {
  it("puts the layered system prompt first, then the path oldest first", () => {
    const messages = assembleContext(path);

    expect(messages[0]).toEqual({ role: "system", content: BASE_SYSTEM_PROMPT });
    expect(messages.slice(1)).toEqual([
      { role: "user", content: "Hej" },
      { role: "assistant", content: "Hej med dig" },
      { role: "user", content: "Forklar loops" },
    ]);
  });

  it("carries the educator's layers into the system message", () => {
    const messages = assembleContext(path, { classroomInstructions: "Svar på dansk." });

    expect(messages[0].content).toContain("Svar på dansk.");
  });

  it("sends only the active path, not every message in the tree", () => {
    // The caller supplies one branch; the loop never widens it (§10).
    expect(assembleContext([path[0]])).toHaveLength(2);
  });
});

describe("runTurn termination", () => {
  it("terminates with exactly one done event on a normal stop", async () => {
    const { adapter } = adapterOver(() => streamingResponse(OK_STREAM));

    const events = await collect(runTurn({ adapter, dialect: "openai", model: "m", path }));

    const dones = events.filter((e) => e.type === "done");
    expect(dones).toHaveLength(1);
    expect(dones[0]).toEqual({ type: "done", reason: "stop" });
    expect(events.at(-1)).toEqual({ type: "done", reason: "stop" });
  });

  it("emits deltas then usage then done, in that order", async () => {
    const { adapter } = adapterOver(() => streamingResponse(OK_STREAM));

    const kinds = (await collect(runTurn({ adapter, dialect: "openai", model: "m", path }))).map(
      (e) => e.type,
    );

    expect(kinds.filter((k, i, all) => k !== all[i - 1])).toEqual(["text-delta", "usage", "done"]);
  });

  it("terminates with reason aborted when the signal fires", async () => {
    const controller = new AbortController();
    controller.abort();
    const { adapter } = adapterOver(() => streamingResponse(OK_STREAM));

    const events = await collect(
      runTurn({ adapter, dialect: "openai", model: "m", path, signal: controller.signal }),
    );

    expect(events.at(-1)).toEqual({ type: "done", reason: "aborted" });
    // An abort is not an error; the student cancelled deliberately (§10).
    expect(events.some((e) => e.type === "error")).toBe(false);
  });

  it("still accounts for the tokens when the signal fires mid-stream", async () => {
    /**
     * The regression this guards (PRD §10): a cancelled read leaves the stream
     * loop by throwing, so the trailing `resolveUsage` was skipped and an
     * aborted turn recorded no usage at all — the gateway had generated and
     * billed the text, and neither the pupil's allowance nor the classroom cap
     * moved. "Usage is never counted as zero" has to hold here above all,
     * because a pupil can abort as often as they like.
     */
    /**
     * The stream delivers text and is then cancelled, which is what the read
     * sees when a pupil presses Stop: an `AbortError` out of the body, after
     * deltas and before the gateway reports usage. Driving it from the response
     * rather than the signal is deliberate — the fetch stub only inspects the
     * signal when the request is made, so a signal fired later would let the
     * turn finish normally and test nothing.
     */
    const { adapter } = adapterOver(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(stream) {
              const frame = JSON.stringify({
                choices: [{ delta: { content: "Et loop gentager noget" } }],
              });
              stream.enqueue(new TextEncoder().encode(`data: ${frame}\n\n`));
            },
            // Erroring here rather than in `start` lets the delta be read first,
            // so the cancellation lands mid-turn instead of before it began.
            pull(stream) {
              stream.error(Object.assign(new Error("aborted"), { name: "AbortError" }));
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    );

    const events = await collect(runTurn({ adapter, dialect: "openai", model: "m", path }));

    expect(events.at(-1)).toEqual({ type: "done", reason: "aborted" });

    const usage = events.filter((event) => event.type === "usage");
    expect(usage).toHaveLength(1);
    const [only] = usage;
    if (only?.type !== "usage") throw new Error("expected a usage event");
    // Estimated, because the gateway never got to report: the figures below are
    // whatever the text produced so far costs, and the point is that they are
    // not zero.
    expect(only.estimated).toBe(true);
    expect(only.inputTokens).toBeGreaterThan(0);
    expect(only.outputTokens).toBeGreaterThan(0);
  });

  it("terminates with an error event and reason error when the gateway fails", async () => {
    const { adapter } = adapterOver(() => new Response("upstream boom", { status: 502 }));

    const events = await collect(runTurn({ adapter, dialect: "openai", model: "m", path }));

    expect(events).toEqual([
      { type: "error", message: "unavailable" },
      { type: "done", reason: "error" },
    ]);
  });

  it("never leaks upstream detail into the student-facing error event", async () => {
    const upstream = "https://api.anthropic.com rejected key sk-ant-abc123: quota exceeded";
    const { adapter } = adapterOver(() => new Response(upstream, { status: 500 }));

    const events = await collect(runTurn({ adapter, dialect: "openai", model: "m", path }));
    const serialised = JSON.stringify(events);

    expect(serialised).not.toContain("anthropic.com");
    expect(serialised).not.toContain("sk-ant");
    expect(serialised).not.toContain("quota exceeded");
  });

  it("preserves partial text emitted before a mid-stream failure", async () => {
    const { adapter } = adapterOver(() =>
      streamingResponse([
        JSON.stringify({ choices: [{ delta: { content: "halvvejs" } }] }),
        "{malformed",
      ]),
    );

    const events = await collect(runTurn({ adapter, dialect: "openai", model: "m", path }));

    expect(events[0]).toEqual({ type: "text-delta", text: "halvvejs" });
    expect(events.at(-1)).toEqual({ type: "done", reason: "error" });
  });

  it("terminates on an empty upstream stream rather than hanging", async () => {
    const { adapter } = adapterOver(() => streamingResponse(["[DONE]"]));

    const events = await collect(runTurn({ adapter, dialect: "openai", model: "m", path }));

    expect(events.at(-1)).toEqual({ type: "done", reason: "stop" });
  });

  it("terminates identically in the anthropic dialect", async () => {
    const { adapter } = adapterOver(() =>
      streamingResponse([
        {
          event: "content_block_delta",
          data: JSON.stringify({ type: "content_block_delta", delta: { text: "svar" } }),
        },
      ]),
    );

    const events = await collect(runTurn({ adapter, dialect: "anthropic", model: "m", path }));

    expect(events.at(-1)).toEqual({ type: "done", reason: "stop" });
  });
});

describe("replaying a turn that used tools (§10, §11)", () => {
  it("pairs each stored call with the result it was given", () => {
    const messages = assembleContext([
      { role: "user", parts: [{ type: "text", text: "Slå det op" }] },
      {
        role: "assistant",
        parts: [
          { type: "text", text: "Et øjeblik" },
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "docs__search",
            serverLabel: "Docs",
            arguments: { q: "loops" },
            decision: "auto",
          },
          { type: "tool-result", toolCallId: "call-1", result: "42 treffer", isError: false },
        ],
      },
    ]);

    expect(messages.slice(1)).toEqual([
      { role: "user", content: "Slå det op" },
      {
        role: "assistant",
        content: "Et øjeblik",
        toolCalls: [{ id: "call-1", name: "docs__search", arguments: '{"q":"loops"}' }],
      },
      { role: "tool", toolCallId: "call-1", content: "42 treffer" },
    ]);
  });

  it("replays a declined call with its refusal, so the model is not left guessing (§11)", () => {
    const messages = assembleContext([
      {
        role: "assistant",
        parts: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "docs__search",
            serverLabel: "Docs",
            arguments: {},
            decision: "declined",
          },
          {
            type: "tool-result",
            toolCallId: "call-1",
            result: "The student declined this tool call.",
            isError: true,
          },
        ],
      },
    ]);

    expect(messages.at(-1)).toEqual({
      role: "tool",
      toolCallId: "call-1",
      content: "The student declined this tool call.",
    });
  });

  it("drops a result whose call is not in the same message", () => {
    const messages = assembleContext([
      {
        role: "assistant",
        parts: [{ type: "tool-result", toolCallId: "orphan", result: "x", isError: false }],
      },
    ]);

    // An orphan tool message would leave the upstream waiting on a call it
    // never saw, so it does not travel.
    expect(messages).toHaveLength(2);
    expect(messages[1].role).toBe("assistant");
  });

  it("sends an image attachment inline, and nothing when its file has gone (§10, §21)", () => {
    const path = [
      {
        role: "user" as const,
        parts: [
          { type: "text" as const, text: "Hvad er der på billedet?" },
          {
            type: "attachment" as const,
            attachmentId: "att-1",
            kind: "image" as const,
            filename: "foto.png",
            mediaType: "image/png",
          },
        ],
      },
    ];

    const withImage = assembleContext(
      path,
      undefined,
      new Map([["att-1", { mediaType: "image/png", data: "AAA" }]]),
    );
    expect(withImage[1].content).toEqual([
      { type: "text", text: "Hvad er der på billedet?" },
      { type: "image", mediaType: "image/png", data: "AAA" },
    ]);

    // A file that has gone is simply not sent; the message still makes sense.
    expect(assembleContext(path)[1].content).toBe("Hvad er der på billedet?");
  });
});
