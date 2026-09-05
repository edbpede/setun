import { describe, expect, it } from "bun:test";
import { recordUsageEvent } from "../db/queries/usage";
import { createTestDatabase, seedTestFixtures } from "../db/testing";
import { GatewayAdapter } from "../gateway/adapter";
import type { GatewayEvent } from "../gateway/events";
import { promptTextOf } from "../gateway/messages";
import { streamingResponse, stubFetch } from "../gateway/testing";
import { estimateTokens } from "../gateway/usage";
import { type BudgetSettings, budgetDayRange, DAILY_WARNING_REQUEST_ID } from "./budgets";
import { claimDailyBudget } from "./daily-budget";
import { assembleContext, runTurn } from "./loop";

/**
 * Per-turn caps inside the loop (plan 2.7, PRD §10, §22).
 *
 * "Hitting a per-turn cap mid-turn ends the turn gracefully: the loop stops at
 * the next clean boundary, partial content is preserved, and the student sees a
 * friendly notice — never an error."
 *
 * A per-turn cap is now a *checkpoint*: it pauses at the next clean boundary and
 * asks, so it can no longer cut a response in flight. The daily allowances are
 * the hard ceilings, and they are what still stops a stream — gracefully: the
 * turn ends with a named reason rather than an error, the text that already
 * streamed survives, and the tokens spent are still accounted for — "usage is
 * never counted as zero" (§10).
 */

const BUDGETS: BudgetSettings = {
  perTurnStepCap: 20,
  perTurnWallClockSeconds: 300,
  perTurnTokenCap: 100_000,
  perStudentDailyTokens: 250_000,
  perClassroomDailyTokens: 2_500_000,
};

const path = [{ role: "user" as const, parts: [{ type: "text" as const, text: "Forklar loops" }] }];
const PROMPT_TOKENS = estimateTokens(promptTextOf(assembleContext(path)));

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

describe("a per-turn cap no longer cuts a response in flight (§10)", () => {
  /**
   * The bug this replaces: a five-minute wall clock cut one long answer at 285
   * seconds, mid-sentence. A cap is now a checkpoint asked at a clean boundary,
   * and a single-step turn has no boundary after the answer — so the answer
   * arrives whole.
   */
  it("streams the whole answer past the token cap", async () => {
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

    expect(doneOf(events)).toEqual({ type: "done", reason: "stop" });
    expect(textOf(events).length).toBe(8 * 400);
  });

  it("streams the whole answer past the wall clock", async () => {
    let clock = 1_000;
    const events = await collect(
      runTurn({
        adapter: adapterOver(LONG_STREAM),
        dialect: "openai",
        model: "m",
        path,
        budgets: { ...BUDGETS, perTurnWallClockSeconds: 1 },
        // Every read of the clock advances it a second, so the cap is long past.
        now: () => {
          clock += 1_000;
          return clock;
        },
      }),
    );

    expect(doneOf(events)).toEqual({ type: "done", reason: "stop" });
    expect(textOf(events).length).toBe(8 * 400);
  });
});

/**
 * The one thing that still stops a response mid-stream: the day's tokens are
 * gone. These are the hard ceilings, and they bind during a turn rather than
 * only at its start (§10).
 */
describe("a daily ceiling binds mid-stream (§10)", () => {
  const tiny = {
    ...BUDGETS,
    perStudentDailyTokens: PROMPT_TOKENS + 250,
    perClassroomDailyTokens: 2_500_000,
  };

  it("stops a live stream when utility usage consumes its remaining classroom headroom", async () => {
    const db = createTestDatabase();
    const fixtures = seedTestFixtures(db);
    const budgets = { ...BUDGETS, perClassroomDailyTokens: PROMPT_TOKENS + 500 };
    const lease = claimDailyBudget({
      db,
      classroomId: fixtures.classroom.id,
      studentId: fixtures.student.id,
      budgets,
      range: budgetDayRange("UTC"),
    });
    const stream = runTurn({
      adapter: adapterOver(LONG_STREAM),
      dialect: "openai",
      model: "m",
      path,
      budgets,
      dailyBudget: lease,
    });
    try {
      expect((await stream.next()).value).toMatchObject({ type: "text-delta" });
      recordUsageEvent(db, {
        classroomId: fixtures.classroom.id,
        studentId: null,
        modelAliasId: fixtures.alias.id,
        inputTokens: 500,
        outputTokens: 0,
        estimated: false,
      });
      const remaining = await collect(stream);
      expect(remaining.some((event) => event.type === "text-delta")).toBe(false);
      expect(doneOf(remaining)).toEqual({ type: "done", reason: "classroom-cap-exhausted" });
    } finally {
      await stream.return(undefined);
      lease.release();
    }
  });

  it("does not start another pupil's stream against tokens already reserved upstream", async () => {
    const db = createTestDatabase();
    const fixtures = seedTestFixtures(db);
    const budgets = { ...BUDGETS, perClassroomDailyTokens: PROMPT_TOKENS + 500 };
    const shared = {
      db,
      classroomId: fixtures.classroom.id,
      budgets,
      range: budgetDayRange("UTC"),
    };
    const firstLease = claimDailyBudget({ ...shared, studentId: fixtures.student.id });
    const secondLease = claimDailyBudget({ ...shared, studentId: "another-pupil" });
    const first = runTurn({
      adapter: adapterOver(LONG_STREAM),
      dialect: "openai",
      model: "m",
      path,
      budgets,
      dailyBudget: firstLease,
    });
    const otherGateway = stubFetch(() => streamingResponse(LONG_STREAM));
    try {
      expect((await first.next()).value).toMatchObject({ type: "text-delta" });
      const second = await collect(
        runTurn({
          adapter: new GatewayAdapter({
            baseUrl: "http://cpa:8317",
            listenerKey: "k",
            fetch: otherGateway.fetch,
          }),
          dialect: "openai",
          model: "m",
          path,
          budgets,
          dailyBudget: secondLease,
        }),
      );
      expect(otherGateway.calls).toHaveLength(0);
      expect(doneOf(second)).toEqual({ type: "done", reason: "classroom-cap-exhausted" });
      expect(doneOf(await collect(first))).toEqual({
        type: "done",
        reason: "classroom-cap-exhausted",
      });
    } finally {
      await first.return(undefined);
      firstLease.release();
      secondLease.release();
    }
  });

  it("does not send a prompt that already consumes the remaining day", async () => {
    const stub = stubFetch(() => streamingResponse(LONG_STREAM));
    const adapter = new GatewayAdapter({
      baseUrl: "http://cpa:8317",
      listenerKey: "k",
      fetch: stub.fetch,
    });
    const events = await collect(
      runTurn({
        adapter,
        dialect: "openai",
        model: "m",
        path,
        budgets: { ...BUDGETS, perStudentDailyTokens: PROMPT_TOKENS },
      }),
    );
    expect(stub.calls).toHaveLength(0);
    expect(usageOf(events)).toBeUndefined();
    expect(doneOf(events)).toEqual({ type: "done", reason: "student-allowance-exhausted" });
  });

  it("stops the turn and names the student's allowance", async () => {
    const events = await collect(
      runTurn({
        adapter: adapterOver(LONG_STREAM),
        dialect: "openai",
        model: "m",
        path,
        budgets: tiny,
        consumed: { studentTokens: 0, classroomTokens: 0 },
      }),
    );

    expect(doneOf(events)).toEqual({ type: "done", reason: "student-allowance-exhausted" });
    expect(events.some((event) => event.type === "error")).toBe(false);
  });

  it("names the classroom cap when that is what ran out", async () => {
    const events = await collect(
      runTurn({
        adapter: adapterOver(LONG_STREAM),
        dialect: "openai",
        model: "m",
        path,
        budgets: { ...BUDGETS, perClassroomDailyTokens: PROMPT_TOKENS + 250 },
        consumed: { studentTokens: 0, classroomTokens: 0 },
      }),
    );

    expect(doneOf(events)).toEqual({ type: "done", reason: "classroom-cap-exhausted" });
  });

  it("counts what the day had already spent before this turn began", async () => {
    const events = await collect(
      runTurn({
        adapter: adapterOver(LONG_STREAM),
        dialect: "openai",
        model: "m",
        path,
        budgets: { ...BUDGETS, perStudentDailyTokens: 10_000 },
        consumed: { studentTokens: 9_900, classroomTokens: 0 },
      }),
    );

    expect(doneOf(events)).toEqual({ type: "done", reason: "student-allowance-exhausted" });
  });

  it("preserves the text that already reached the student, and prices it", async () => {
    const events = await collect(
      runTurn({
        adapter: adapterOver(LONG_STREAM),
        dialect: "openai",
        model: "m",
        path,
        budgets: tiny,
      }),
    );

    const text = textOf(events);
    expect(text.length).toBeGreaterThan(0);
    expect(text.length).toBeLessThan(8 * 400);

    const usage = usageOf(events);
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
        budgets: tiny,
      }),
    );

    expect(events.at(-1)?.type).toBe("done");
    expect(events.at(-2)?.type).toBe("usage");
  });
});

describe("the 70 % warning (§10)", () => {
  it("is emitted once, mid-stream, with the figures the pupil is shown", async () => {
    const events = await collect(
      runTurn({
        adapter: adapterOver(LONG_STREAM),
        dialect: "openai",
        model: "m",
        path,
        budgets: { ...BUDGETS, perStudentDailyTokens: PROMPT_TOKENS + 1_000 },
      }),
    );

    const warnings = events.filter((event) => event.type === "budget-warning");
    expect(warnings.length).toBe(1);

    const warning = warnings[0];
    if (warning.type !== "budget-warning") throw new Error("expected a budget warning");
    expect(warning.requestId).toBe(DAILY_WARNING_REQUEST_ID);
    expect(warning.fraction).toBeGreaterThanOrEqual(0.7);
    expect(warning.limitTokens).toBe(PROMPT_TOKENS + 1_000);
    expect(warning.usedTokens).toBeGreaterThanOrEqual(700);

    // The answer in flight is never cut for a warning.
    expect(doneOf(events)).toEqual({ type: "done", reason: "stop" });
    expect(textOf(events).length).toBe(8 * 400);
  });

  it("stays quiet while the day has headroom", async () => {
    const events = await collect(
      runTurn({
        adapter: adapterOver(LONG_STREAM),
        dialect: "openai",
        model: "m",
        path,
        budgets: BUDGETS,
      }),
    );

    expect(events.some((event) => event.type === "budget-warning")).toBe(false);
  });
});

/**
 * A provider that stopped at its own output ceiling (§10).
 *
 * The answer is cut mid-sentence, and until the dialects read `finish_reason`
 * it looked exactly like a model finishing its thought.
 */
describe("a truncated response (§10)", () => {
  const TRUNCATED_STREAM = [
    JSON.stringify({ choices: [{ delta: { content: "Halvvejs igennem" } }] }),
    JSON.stringify({ choices: [{ delta: {}, finish_reason: "length" }] }),
    JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 4 } }),
    "[DONE]",
  ];

  it("ends the turn as truncated, keeping what arrived", async () => {
    const events = await collect(
      runTurn({
        adapter: adapterOver(TRUNCATED_STREAM),
        dialect: "openai",
        model: "m",
        path,
        budgets: BUDGETS,
      }),
    );

    expect(doneOf(events)).toEqual({ type: "done", reason: "truncated" });
    expect(textOf(events)).toBe("Halvvejs igennem");
  });

  it("leaves a clean stop alone", async () => {
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
