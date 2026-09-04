import { describe, expect, it } from "bun:test";
import type { AppDatabase } from "../db/client";
import {
  allowTool,
  listMcpTools,
  setMcpServerEnabled,
  setMcpToolFlags,
  syncMcpTools,
  upsertMcpServer,
} from "../db/queries/mcp";
import { createSkill, grantSkill } from "../db/queries/skills";
import type { PermissionMode } from "../db/schema";
import { createTestDatabase, seedTestFixtures } from "../db/testing";
import { GatewayAdapter } from "../gateway/adapter";
import type { GatewayEvent } from "../gateway/events";
import { streamingResponse, stubFetch } from "../gateway/testing";
import { McpClient } from "../mcp/client";
import type { McpServerConfig } from "../mcp/config";
import { resolveSkills } from "../skills/registry";
import { FileStore } from "../storage/files";
import { TurnInteractionRegistry } from "./interactions";
import { runTurn } from "./loop";
import { buildToolSet, type ToolContext } from "./tools";

/**
 * Tool execution inside the agent loop (plan 3.4, 3.5, 3.6, PRD §10, §11, §22).
 *
 * §22 asks for "tool execution round trips with each permission mode" and
 * "elicitation round trips" as integration coverage, plus agent-loop termination
 * conditions in `bun test`. Everything below runs the real loop over the real
 * dialect parsing and the real MCP transport; only the two sockets are stubbed.
 */

const SERVER_CONFIG: McpServerConfig = {
  key: "docs",
  label: "Skolens dokumenter",
  url: "http://mcp.test/mcp",
  headers: {},
  parameterHeaderAllowlist: [],
};

const PATH = [{ role: "user" as const, parts: [{ type: "text" as const, text: "Slå det op" }] }];

/** A gateway that asks for one tool on its first call and answers on its second. */
function toolThenAnswer(toolName: string) {
  let call = 0;

  return stubFetch(() => {
    call++;
    if (call === 1) {
      return streamingResponse([
        JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call-1",
                    function: { name: toolName, arguments: '{"q":"loops"}' },
                  },
                ],
              },
            },
          ],
        }),
        JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 } }),
        "[DONE]",
      ]);
    }

    return streamingResponse([
      JSON.stringify({ choices: [{ delta: { content: "Her er svaret" } }] }),
      JSON.stringify({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 4 } }),
      "[DONE]",
    ]);
  });
}

/** An MCP server that answers `tools/call` with a scripted sequence of results. */
function mcpServer(results: unknown[]) {
  let index = 0;
  const calls: { method: string; params: Record<string, unknown> }[] = [];

  const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const payload = JSON.parse(String(init?.body)) as {
      id?: number;
      method: string;
      params: Record<string, unknown>;
    };
    calls.push({ method: payload.method, params: payload.params });

    const result = (() => {
      switch (payload.method) {
        case "server/discover":
          return { protocolVersion: "2026-07-28", capabilities: { tools: {}, elicitation: {} } };
        case "tools/list":
          return { tools: [{ name: "search", description: "Find things" }] };
        case "tools/call":
          return results[Math.min(index++, results.length - 1)];
        default:
          return {};
      }
    })();

    return new Response(JSON.stringify({ jsonrpc: "2.0", id: payload.id, result }), {
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;

  return { fetch, calls };
}

function seedAllowedTool(db: AppDatabase, classroomId: string, sensitive = false) {
  const server = upsertMcpServer(db, { configKey: "docs", label: "Skolens dokumenter" });
  setMcpServerEnabled(db, { serverId: server.id, enabled: true });
  syncMcpTools(db, {
    serverId: server.id,
    tools: [{ name: "search", description: "Find things", inputSchema: null }],
  });

  const tool = listMcpTools(db, server.id)[0];
  setMcpToolFlags(db, { toolId: tool.id, enabled: true, sensitive });
  allowTool(db, { classroomId, mcpToolId: tool.id });
}

interface Harness {
  db: AppDatabase;
  context: ToolContext;
  adapter: GatewayAdapter;
  interactions: TurnInteractionRegistry;
  gatewayCalls: () => number;
  mcpCalls: () => { method: string; params: Record<string, unknown> }[];
}

function harness(
  options: { results?: unknown[]; toolName?: string; sensitive?: boolean; withTool?: boolean } = {},
): Harness {
  const db = createTestDatabase();
  const fixtures = seedTestFixtures(db);
  if (options.withTool !== false) {
    seedAllowedTool(db, fixtures.classroom.id, options.sensitive ?? false);
  }

  const gateway = toolThenAnswer(options.toolName ?? "docs__search");
  const mcp = mcpServer(options.results ?? [{ content: [{ type: "text", text: "42 treffer" }] }]);

  const adapter = new GatewayAdapter({
    baseUrl: "http://cpa:8317",
    listenerKey: "k",
    fetch: gateway.fetch,
  });

  const context: ToolContext = {
    db,
    adapter,
    files: new FileStore("/tmp/setun-test-unused"),
    mcp: new McpClient([SERVER_CONFIG], { fetch: mcp.fetch }),
    classroom: fixtures.classroom,
    studentId: fixtures.student.id,
    conversationId: crypto.randomUUID(),
    skills: resolveSkills(db, {
      classroomId: fixtures.classroom.id,
      studentId: fixtures.student.id,
      authoringPolicy: "immediate",
    }),
  };

  return {
    db,
    context,
    adapter,
    interactions: new TurnInteractionRegistry(),
    gatewayCalls: () => gateway.calls.length,
    mcpCalls: () => mcp.calls,
  };
}

/**
 * Drive a turn, answering whatever it asks.
 *
 * The answer is delivered after the loop has begun waiting, which is a real
 * ordering rather than a test convenience: a student cannot click a button that
 * has not been rendered yet either.
 */
async function drive(
  test: Harness,
  mode: PermissionMode,
  respond?: (
    event: GatewayEvent,
  ) =>
    | { kind: "permission"; approved: boolean }
    | { kind: "elicitation"; values: Record<string, string | number | boolean>; declined: boolean }
    | null,
): Promise<GatewayEvent[]> {
  const turnId = crypto.randomUUID();
  const events: GatewayEvent[] = [];

  for await (const event of runTurn({
    adapter: test.adapter,
    dialect: "openai",
    model: "test-model",
    path: PATH,
    tooling: {
      tools: buildToolSet(test.context),
      context: test.context,
      mode,
      turnId,
      interactions: test.interactions,
    },
  })) {
    events.push(event);

    const answer = respond?.(event);
    if (!answer) continue;

    const requestId =
      "toolCallId" in event && typeof event.toolCallId === "string" ? event.toolCallId : "";
    void deliver(test.interactions, turnId, requestId, answer);
  }

  return events;
}

/** Retry until the loop is actually waiting; it registers just after the yield. */
async function deliver(
  interactions: TurnInteractionRegistry,
  turnId: string,
  requestId: string,
  answer: Parameters<TurnInteractionRegistry["answer"]>[0]["answer"],
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (interactions.answer({ turnId, requestId, answer })) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

describe("tool round trips in each permission mode (§11, §22)", () => {
  it("open runs the tool silently and continues the loop", async () => {
    const test = harness();
    const events = await drive(test, "open");

    expect(events.map((event) => event.type)).toContain("tool-call-started");
    expect(events.some((event) => event.type === "permission-request")).toBe(false);

    const result = events.find((event) => event.type === "tool-result");
    expect(result).toMatchObject({ isError: false, result: "42 treffer" });

    // The model was called again with the result, and answered.
    expect(test.gatewayCalls()).toBe(2);
    expect(events.filter((event) => event.type === "text-delta")).toHaveLength(1);
    expect(events.at(-1)).toEqual({ type: "done", reason: "stop" });
  });

  it("standard runs an unflagged tool without asking", async () => {
    const test = harness({ sensitive: false });
    const events = await drive(test, "standard");

    expect(events.some((event) => event.type === "permission-request")).toBe(false);
    expect(events.some((event) => event.type === "tool-call-started")).toBe(true);
  });

  it("standard asks about a sensitive tool, and runs it when approved", async () => {
    const test = harness({ sensitive: true });
    const events = await drive(test, "standard", (event) =>
      event.type === "permission-request" ? { kind: "permission", approved: true } : null,
    );

    const request = events.find((event) => event.type === "permission-request");
    expect(request).toMatchObject({ sensitive: true, serverLabel: "Skolens dokumenter" });
    // The student is approving something specific, not a bare name (§11).
    expect(request && "arguments" in request && request.arguments).toEqual({ q: "loops" });

    expect(events.some((event) => event.type === "tool-call-started")).toBe(true);
    expect(events.find((event) => event.type === "tool-result")).toMatchObject({ isError: false });
  });

  it("strict asks about every call, including an unflagged one", async () => {
    const test = harness({ sensitive: false });
    const events = await drive(test, "strict", (event) =>
      event.type === "permission-request" ? { kind: "permission", approved: true } : null,
    );

    expect(events.find((event) => event.type === "permission-request")).toMatchObject({
      sensitive: false,
    });
    expect(events.some((event) => event.type === "tool-call-started")).toBe(true);
  });

  it("returns a refusal and continues the loop when the student declines (§11)", async () => {
    const test = harness({ sensitive: false });
    const events = await drive(test, "strict", (event) =>
      event.type === "permission-request" ? { kind: "permission", approved: false } : null,
    );

    // The tool never ran, and the server was never called for it.
    expect(events.some((event) => event.type === "tool-call-started")).toBe(false);
    expect(test.mcpCalls().some((call) => call.method === "tools/call")).toBe(false);

    const result = events.find((event) => event.type === "tool-result");
    expect(result).toMatchObject({ isError: true, decision: "declined" });

    // "A declined tool call returns a refusal result to the model and the loop
    // continues" — so the model answered afterwards (§11).
    expect(test.gatewayCalls()).toBe(2);
    expect(events.at(-1)).toEqual({ type: "done", reason: "stop" });
  });

  it("continues without the tool when nobody answers, rather than hanging", async () => {
    const test = harness({ sensitive: false });

    const turnId = crypto.randomUUID();
    const events: GatewayEvent[] = [];
    for await (const event of runTurn({
      adapter: test.adapter,
      dialect: "openai",
      model: "test-model",
      path: PATH,
      // A one-second wall clock, so the unanswered wait is bounded by the turn.
      budgets: {
        perTurnStepCap: 20,
        perTurnWallClockSeconds: 1,
        perTurnTokenCap: 100_000,
        perStudentDailyTokens: 250_000,
        perClassroomDailyTokens: 2_500_000,
      },
      tooling: {
        tools: buildToolSet(test.context),
        context: {
          ...test.context,
          classroom: { ...test.context.classroom, perTurnWallClockSeconds: 1 },
        },
        mode: "strict",
        turnId,
        interactions: test.interactions,
      },
    })) {
      events.push(event);
    }

    expect(events.find((event) => event.type === "tool-result")).toMatchObject({
      isError: true,
      decision: "unanswered",
    });
    expect(events.at(-1)?.type).toBe("done");
  });
});

describe("elicitation round trip (§11, §22)", () => {
  const ELICITING = {
    content: [],
    elicitation: {
      message: "Hvilken by?",
      requestedSchema: {
        type: "object",
        required: ["city"],
        properties: { city: { type: "string", title: "By" } },
      },
    },
  };

  it("surfaces the request with server attribution and retries with the answer", async () => {
    const test = harness({
      results: [ELICITING, { content: [{ type: "text", text: "12 grader i Aarhus" }] }],
    });

    const events = await drive(test, "open", (event) =>
      event.type === "elicitation-request"
        ? { kind: "elicitation", values: { city: "Aarhus" }, declined: false }
        : null,
    );

    const request = events.find((event) => event.type === "elicitation-request");
    expect(request).toMatchObject({
      message: "Hvilken by?",
      serverLabel: "Skolens dokumenter",
      toolName: "docs__search",
    });
    expect(request && "fields" in request && request.fields).toEqual([
      { name: "city", label: "By", type: "text", required: true },
    ]);

    // The original request was retried with the responses attached (§11).
    const calls = test.mcpCalls().filter((call) => call.method === "tools/call");
    expect(calls).toHaveLength(2);
    expect(calls[0].params.arguments).toEqual({ q: "loops" });
    expect(calls[1].params.arguments).toEqual({ q: "loops" });
    expect(calls[1].params._meta).toBeDefined();

    expect(events.find((event) => event.type === "tool-result")).toMatchObject({
      result: "12 grader i Aarhus",
      isError: false,
    });
  });

  it("gives up on the call when the student declines to answer", async () => {
    const test = harness({ results: [ELICITING] });

    const events = await drive(test, "open", (event) =>
      event.type === "elicitation-request"
        ? { kind: "elicitation", values: {}, declined: true }
        : null,
    );

    expect(events.find((event) => event.type === "tool-result")).toMatchObject({ isError: true });
    // Only the original call was made; nothing was retried without an answer.
    expect(test.mcpCalls().filter((call) => call.method === "tools/call")).toHaveLength(1);
    expect(events.at(-1)).toEqual({ type: "done", reason: "stop" });
  });
});

describe("loop termination with tools (§10, §22)", () => {
  it("refuses a tool the classroom does not allowlist, by name (§11, §21)", async () => {
    const test = harness({ withTool: false, toolName: "docs__search" });
    const events = await drive(test, "open");

    // The model asked for something outside the set; nothing reached a server.
    expect(test.mcpCalls().some((call) => call.method === "tools/call")).toBe(false);
    expect(events.find((event) => event.type === "tool-result")).toMatchObject({ isError: true });
    expect(events.at(-1)).toEqual({ type: "done", reason: "stop" });
  });

  /**
   * A per-turn cap is a checkpoint, not a ceiling (§10).
   *
   * The runaway loop still stops — but by asking the pupil at a clean boundary
   * rather than by cutting the turn off, and saying yes buys another allotment.
   */
  const CHECKPOINT_BUDGETS = {
    perTurnStepCap: 3,
    // Also the time every question may wait, so an unanswered checkpoint ends
    // the turn a second later rather than five minutes later.
    perTurnWallClockSeconds: 1,
    perTurnTokenCap: 1_000_000,
    perStudentDailyTokens: 250_000,
    perClassroomDailyTokens: 2_500_000,
  };

  /**
   * Drive a loop over a gateway that asks for the same tool every time, with a
   * scripted reply to each question it asks. A reply arrives while the loop is
   * suspended on the `yield`, which is exactly how a pupil's click arrives.
   */
  async function runCheckpointed(options: {
    budgets?: typeof CHECKPOINT_BUDGETS;
    consumed?: { studentTokens: number; classroomTokens: number };
    answers?: readonly boolean[];
    answerWarning?: boolean;
  }) {
    const db = createTestDatabase();
    const fixtures = seedTestFixtures(db);
    seedAllowedTool(db, fixtures.classroom.id);

    const gateway = stubFetch(() =>
      streamingResponse([
        JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: crypto.randomUUID(),
                    function: { name: "docs__search", arguments: "{}" },
                  },
                ],
              },
            },
          ],
        }),
        JSON.stringify({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
        "[DONE]",
      ]),
    );
    const mcp = mcpServer([{ content: [{ type: "text", text: "igen" }] }]);

    const adapter = new GatewayAdapter({
      baseUrl: "http://cpa:8317",
      listenerKey: "k",
      fetch: gateway.fetch,
    });
    const context: ToolContext = {
      db,
      adapter,
      files: new FileStore("/tmp/setun-test-unused"),
      mcp: new McpClient([SERVER_CONFIG], { fetch: mcp.fetch }),
      classroom: fixtures.classroom,
      studentId: fixtures.student.id,
      conversationId: crypto.randomUUID(),
      skills: resolveSkills(db, {
        classroomId: fixtures.classroom.id,
        studentId: fixtures.student.id,
        authoringPolicy: "immediate",
      }),
    };

    const interactions = new TurnInteractionRegistry();
    const turnId = crypto.randomUUID();
    const answers = [...(options.answers ?? [])];

    const events: GatewayEvent[] = [];
    for await (const event of runTurn({
      adapter,
      dialect: "openai",
      model: "test-model",
      path: PATH,
      budgets: options.budgets ?? CHECKPOINT_BUDGETS,
      consumed: options.consumed,
      tooling: {
        tools: buildToolSet(context),
        context,
        mode: "open",
        turnId,
        interactions,
      },
    })) {
      events.push(event);

      if (event.type === "continue-request") {
        const proceed = answers.shift();
        if (proceed !== undefined) {
          interactions.answer({
            turnId,
            requestId: event.requestId,
            answer: { kind: "continue", proceed },
          });
        }
      }

      if (event.type === "budget-warning" && options.answerWarning !== undefined) {
        interactions.answer({
          turnId,
          requestId: event.requestId,
          answer: { kind: "continue", proceed: options.answerWarning },
        });
      }
    }

    return { events, gateway };
  }

  it("asks at the step checkpoint, and ends the turn when nobody answers", async () => {
    const { events, gateway } = await runCheckpointed({});

    expect(gateway.calls).toHaveLength(3);

    const asked = events.filter((event) => event.type === "continue-request");
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({
      type: "continue-request",
      requestId: "continue-1",
      cause: "steps",
      caps: ["steps"],
    });

    // The partial content is preserved and the pupil is told, never shown an
    // error (§10).
    expect(events.at(-1)).toEqual({ type: "done", reason: "budget" });
  });

  it("grants another allotment when the pupil says to keep going", async () => {
    const { events, gateway } = await runCheckpointed({ answers: [true] });

    // Three more steps before the second checkpoint, and a question of its own.
    expect(gateway.calls).toHaveLength(6);
    expect(
      events
        .filter((event) => event.type === "continue-request")
        .map((event) => event.type === "continue-request" && event.requestId),
    ).toEqual(["continue-1", "continue-2"]);
    expect(events.at(-1)).toEqual({ type: "done", reason: "budget" });
  });

  it("ends the turn as a stop when the pupil says stop here", async () => {
    const { events, gateway } = await runCheckpointed({ answers: [false] });

    expect(gateway.calls).toHaveLength(3);
    expect(events.at(-1)).toEqual({ type: "done", reason: "aborted" });
  });

  /**
   * The 70 % warning is shown mid-stream and confirmed at the next boundary — so
   * a pupil who never sees the banner is still asked before more work is done.
   */
  it("asks at the boundary when the warning was not acknowledged", async () => {
    const { events } = await runCheckpointed({
      budgets: { ...CHECKPOINT_BUDGETS, perStudentDailyTokens: 100 },
      consumed: { studentTokens: 70, classroomTokens: 0 },
    });

    expect(events.some((event) => event.type === "budget-warning")).toBe(true);

    const asked = events.filter((event) => event.type === "continue-request");
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ requestId: "daily-warning", cause: "daily-warning" });
    expect(events.at(-1)).toEqual({ type: "done", reason: "budget" });
  });

  it("does not ask again when the pupil already pressed Keep going", async () => {
    const { events } = await runCheckpointed({
      budgets: { ...CHECKPOINT_BUDGETS, perTurnStepCap: 100, perStudentDailyTokens: 100 },
      consumed: { studentTokens: 70, classroomTokens: 0 },
      answerWarning: true,
    });

    expect(events.some((event) => event.type === "budget-warning")).toBe(true);
    expect(events.some((event) => event.type === "continue-request")).toBe(false);
    // It ran on until the allowance itself ran out — the hard ceiling (§10).
    expect(events.at(-1)).toEqual({ type: "done", reason: "student-allowance-exhausted" });
  });

  /**
   * A step the provider cut at its own output ceiling (§10).
   *
   * The arguments the model was writing are half-finished, so acting on them
   * would mean running a call it never finished asking for. The pupil is told
   * the answer was cut short instead.
   */
  it("runs no tools from a step the provider truncated", async () => {
    const db = createTestDatabase();
    const fixtures = seedTestFixtures(db);
    seedAllowedTool(db, fixtures.classroom.id);

    const gateway = stubFetch(() =>
      streamingResponse([
        JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call-1",
                    function: { name: "docs__search", arguments: '{"q":"lo' },
                  },
                ],
              },
            },
          ],
        }),
        JSON.stringify({ choices: [{ delta: {}, finish_reason: "length" }] }),
        JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 4 } }),
        "[DONE]",
      ]),
    );
    const mcp = mcpServer([{ content: [{ type: "text", text: "aldrig" }] }]);

    const adapter = new GatewayAdapter({
      baseUrl: "http://cpa:8317",
      listenerKey: "k",
      fetch: gateway.fetch,
    });
    const context: ToolContext = {
      db,
      adapter,
      files: new FileStore("/tmp/setun-test-unused"),
      mcp: new McpClient([SERVER_CONFIG], { fetch: mcp.fetch }),
      classroom: fixtures.classroom,
      studentId: fixtures.student.id,
      conversationId: crypto.randomUUID(),
      skills: resolveSkills(db, {
        classroomId: fixtures.classroom.id,
        studentId: fixtures.student.id,
        authoringPolicy: "immediate",
      }),
    };

    const events: GatewayEvent[] = [];
    for await (const event of runTurn({
      adapter,
      dialect: "openai",
      model: "test-model",
      path: PATH,
      tooling: {
        tools: buildToolSet(context),
        context,
        mode: "open",
        turnId: crypto.randomUUID(),
        interactions: new TurnInteractionRegistry(),
      },
    })) {
      events.push(event);
    }

    expect(mcp.calls.some((call) => call.method === "tools/call")).toBe(false);
    expect(events.some((event) => event.type === "tool-call-started")).toBe(false);
    expect(events.at(-1)).toEqual({ type: "done", reason: "truncated" });
  });

  it("cancels a running tool call when the turn is aborted (§10)", async () => {
    const db = createTestDatabase();
    const fixtures = seedTestFixtures(db);
    seedAllowedTool(db, fixtures.classroom.id);

    const controller = new AbortController();
    const gateway = toolThenAnswer("docs__search");

    // A server that never answers; only the abort ends the call.
    const hangingFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body)) as { id?: number; method: string };
      if (payload.method !== "tools/call") {
        const result =
          payload.method === "tools/list"
            ? { tools: [{ name: "search", description: "Find things" }] }
            : { protocolVersion: "2026-07-28", capabilities: { tools: {} } };
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: payload.id, result }), {
          headers: { "content-type": "application/json" },
        });
      }

      // Aborted from outside while the call is in flight, which is what a
      // student pressing Stop does.
      setTimeout(() => controller.abort(), 0);

      return new Promise<Response>((_, reject) => {
        const abort = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        if (init?.signal?.aborted) abort();
        else init?.signal?.addEventListener("abort", abort, { once: true });
      });
    }) as unknown as typeof globalThis.fetch;

    const adapter = new GatewayAdapter({
      baseUrl: "http://cpa:8317",
      listenerKey: "k",
      fetch: gateway.fetch,
    });
    const context: ToolContext = {
      db,
      adapter,
      files: new FileStore("/tmp/setun-test-unused"),
      mcp: new McpClient([SERVER_CONFIG], { fetch: hangingFetch }),
      classroom: fixtures.classroom,
      studentId: fixtures.student.id,
      conversationId: crypto.randomUUID(),
      skills: resolveSkills(db, {
        classroomId: fixtures.classroom.id,
        studentId: fixtures.student.id,
        authoringPolicy: "immediate",
      }),
    };

    const events: GatewayEvent[] = [];
    for await (const event of runTurn({
      adapter,
      dialect: "openai",
      model: "test-model",
      path: PATH,
      signal: controller.signal,
      tooling: {
        tools: buildToolSet(context),
        context,
        mode: "open",
        turnId: crypto.randomUUID(),
        interactions: new TurnInteractionRegistry(),
      },
    })) {
      events.push(event);
    }

    expect(events.at(-1)).toEqual({ type: "done", reason: "aborted" });
  });
});

describe("the internal skill loader (§12)", () => {
  it("loads a skill without ever asking for permission, in strict mode", async () => {
    const db = createTestDatabase();
    const fixtures = seedTestFixtures(db);

    const written = createSkill(db, {
      origin: "panel",
      name: "danskstil",
      description: "Sådan skriver du en dansk stil",
      body: "Start med en indledning.",
      enabled: true,
    });
    grantSkill(db, { classroomId: fixtures.classroom.id, skillId: written.id });

    const gateway = toolThenAnswer("load_skill");
    const adapter = new GatewayAdapter({
      baseUrl: "http://cpa:8317",
      listenerKey: "k",
      fetch: gateway.fetch,
    });
    const context: ToolContext = {
      db,
      adapter,
      files: new FileStore("/tmp/setun-test-unused"),
      mcp: null,
      classroom: fixtures.classroom,
      studentId: fixtures.student.id,
      conversationId: crypto.randomUUID(),
      skills: resolveSkills(db, {
        classroomId: fixtures.classroom.id,
        studentId: fixtures.student.id,
        authoringPolicy: "immediate",
      }),
    };

    // The gateway stub asks for `{"q":"loops"}`, which the loader reads as no
    // name; what matters here is that strict mode did not stop it.
    const events: GatewayEvent[] = [];
    for await (const event of runTurn({
      adapter,
      dialect: "openai",
      model: "test-model",
      path: PATH,
      tooling: {
        tools: buildToolSet(context),
        context,
        mode: "strict",
        turnId: crypto.randomUUID(),
        interactions: new TurnInteractionRegistry(),
      },
    })) {
      events.push(event);
    }

    expect(events.some((event) => event.type === "permission-request")).toBe(false);
    expect(events.some((event) => event.type === "tool-call-started")).toBe(true);
    // A load consumes a step like any other tool invocation (§12).
    expect(gateway.calls).toHaveLength(2);
  });
});
