import { describe, expect, it } from "bun:test";
import { GatewayAdapter } from "../gateway/adapter";
import type { GatewayEvent } from "../gateway/events";
import { streamingResponse, stubFetch } from "../gateway/testing";
import type { BudgetSettings } from "./budgets";
import { runTurn } from "./loop";

/**
 * Per-turn caps inside the loop (plan 2.7, PRD §10, §22).
 *
 * "Hitting a per-turn cap mid-turn ends the turn gracefully: the loop stops at
 * the next clean boundary, partial content is preserved, and the student sees a
 * friendly notice — never an error."
 *
 * So the assertions are about three things together: the turn ends with
 * `done: budget` rather than `error`, the text that already streamed survives,
 * and the tokens spent are still accounted for — "usage is never counted as
 * zero" (§10).
 */

const BUDGETS: BudgetSettings = {
  perTurnStepCap: 20,
  perTurnWallClockSeconds: 300,
  perTurnTokenCap: 100_000,
  perStudentDailyTokens: 250_000,
  perClassroomDailyTokens: 2_500_000,
};

const path = [{ role: "user" as const, parts: [{ type: "text" as const, text: "Forklar loops" }] }];

function adapterOver(records: string[]) {
  const stub = stubFetch(() => streamingResponse(records));
  return new GatewayAdapter({ baseUrl: "http://cpa:8317", listenerKey: "k", fetch: stub.fetch });
}

async function collect(events: AsyncGenerator<GatewayEvent>): Promise<GatewayEvent[]> {
  const out: GatewayEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

const textOf = (events: GatewayEvent[]) =>
  events
    .filter((event) => event.type === "text-delta")
    .map((event) => event.text)
    .join("");

const doneOf = (events: GatewayEvent[]) => events.find((event) => event.type === "done");
const usageOf = (events: GatewayEvent[]) => events.find((event) => event.type === "usage");

/** A long stream, so a token cap can bind partway through it. */
const LONG_STREAM = [
  ...Array.from({ length: 8 }, (_, index) =>
    JSON.stringify({ choices: [{ delta: { content: `${index}`.repeat(400) } }] }),
  ),
  JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 800 } }),
  "[DONE]",
];

describe("the token cap binds mid-stream (§10)", () => {
  it("ends the turn as a budget stop, not an error", async () => {
    const events = await collect(
      runTurn({
        adapter: adapterOver(LONG_STREAM),
        dialect: "openai",
        model: "m",
        path,
        // Roughly two chunks' worth at four characters per token.
        budgets: { ...BUDGETS, perTurnTokenCap: 200 },
      }),
    );

    expect(doneOf(events)).toEqual({ type: "done", reason: "budget" });
    expect(events.some((event) => event.type === "error")).toBe(false);
  });

  it("preserves the text that already reached the student", async () => {
    const events = await collect(
      runTurn({
        adapter: adapterOver(LONG_STREAM),
        dialect: "openai",
        model: "m",
        path,
        budgets: { ...BUDGETS, perTurnTokenCap: 200 },
      }),
    );

    const text = textOf(events);
    expect(text.length).toBeGreaterThan(0);
    // It stopped early: the whole stream would have been eight chunks.
    expect(text.length).toBeLessThan(8 * 400);
  });

  it("still accounts for the tokens spent — usage is never zero (§10)", async () => {
    const events = await collect(
      runTurn({
        adapter: adapterOver(LONG_STREAM),
        dialect: "openai",
        model: "m",
        path,
        budgets: { ...BUDGETS, perTurnTokenCap: 200 },
      }),
    );

    const usage = usageOf(events);
    expect(usage).toBeDefined();
    if (usage?.type !== "usage") throw new Error("expected a usage event");

    // The gateway never got to report, so the figure is estimated and flagged.
    expect(usage.estimated).toBe(true);
    expect(usage.outputTokens).toBeGreaterThan(0);
    expect(usage.inputTokens).toBeGreaterThan(0);
  });

  it("puts the usage event before the terminal done", async () => {
    const events = await collect(
      runTurn({
        adapter: adapterOver(LONG_STREAM),
        dialect: "openai",
        model: "m",
        path,
        budgets: { ...BUDGETS, perTurnTokenCap: 200 },
      }),
    );

    expect(events.at(-1)?.type).toBe("done");
    expect(events.at(-2)?.type).toBe("usage");
  });
});

describe("the wall-clock cap binds mid-stream (§10)", () => {
  it("stops the turn once the turn's time is up", async () => {
    let clock = 1_000;
    const events = await collect(
      runTurn({
        adapter: adapterOver(LONG_STREAM),
        dialect: "openai",
        model: "m",
        path,
        budgets: { ...BUDGETS, perTurnWallClockSeconds: 1 },
        // Each check advances the clock by a second; the first event is enough.
        now: () => {
          clock += 1_000;
          return clock;
        },
      }),
    );

    expect(doneOf(events)).toEqual({ type: "done", reason: "budget" });
    expect(textOf(events).length).toBeGreaterThan(0);
  });
});

describe("a turn inside its caps is unaffected", () => {
  it("completes normally and keeps the gateway's reported usage", async () => {
    const events = await collect(
      runTurn({
        adapter: adapterOver(LONG_STREAM),
        dialect: "openai",
        model: "m",
        path,
        budgets: BUDGETS,
      }),
    );

    expect(doneOf(events)).toEqual({ type: "done", reason: "stop" });
    expect(textOf(events).length).toBe(8 * 400);

    const usage = usageOf(events);
    if (usage?.type !== "usage") throw new Error("expected a usage event");
    // Reported, not estimated: the stream ran to completion (§10).
    expect(usage.estimated).toBe(false);
    expect(usage.outputTokens).toBe(800);
  });

  it("does not synthesise usage when the gateway never answered at all", async () => {
    const stub = stubFetch(() => {
      throw new Error("connection refused");
    });
    const adapter = new GatewayAdapter({
      baseUrl: "http://cpa:8317",
      listenerKey: "k",
      fetch: stub.fetch,
    });

    const events = await collect(
      runTurn({ adapter, dialect: "openai", model: "m", path, budgets: BUDGETS }),
    );

    // No request reached a provider, so no tokens were spent; inventing an
    // estimate here would charge a pupil for a failure (§10).
    expect(usageOf(events)).toBeUndefined();
    expect(doneOf(events)).toEqual({ type: "done", reason: "error" });
  });
});
