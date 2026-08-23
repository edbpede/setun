import type { Message, MessagePart, PermissionMode } from "../db/schema";
import type { DialectName, GatewayAdapter } from "../gateway/adapter";
import type { GatewayContentPart, GatewayMessage, GatewayToolCall } from "../gateway/dialect";
import { GatewayError } from "../gateway/errors";
import type { GatewayEvent, TurnEndReason } from "../gateway/events";
import { promptTextOf } from "../gateway/messages";
import { estimateTokens, resolveUsage } from "../gateway/usage";
import { BUDGET_PRESETS, type BudgetSettings, TurnBudget } from "./budgets";
import type { InteractionAnswer, TurnInteractionRegistry } from "./interactions";
import {
  DECLINED_RESULT,
  type PermissionDecision,
  requiresPermission,
  UNANSWERED_RESULT,
} from "./permissions";
import { buildSystemPrompt, type SystemPromptLayers } from "./system-prompt";
import { executeTool, type ToolContext, type ToolSet } from "./tools";

/**
 * The agent loop (PRD §10, §11).
 *
 * "Assemble context, call the model, stream deltas to the client, execute any
 * requested tools, append results, repeat until the model stops or a budget is
 * exhausted. Plain chat is the zero-tool case."
 *
 * Everything the loop does to a tool call happens here and nowhere else: the
 * permission mode is applied before execution, a declined call returns a refusal
 * and the loop continues, an interim result asking for input is surfaced and the
 * call retried, and the per-turn budget bounds the whole thing (§10, §11).
 */

/** Everything the loop needs to run tools. Absent for the zero-tool case (§10). */
export interface TurnTooling {
  readonly tools: ToolSet;
  readonly context: ToolContext;
  readonly mode: PermissionMode;
  /** Questions to the student are answered against this turn's identifier (§11). */
  readonly turnId: string;
  readonly interactions: TurnInteractionRegistry;
}

export interface RunTurnInput {
  readonly adapter: GatewayAdapter;
  readonly dialect: DialectName;
  readonly model: string;
  /** The active path of the message tree, oldest first (§10). */
  readonly path: readonly Pick<Message, "role" | "parts">[];
  /**
   * Image attachments, already read from storage and base64-encoded.
   *
   * Resolved by the caller rather than here: the loop stays pure over stored
   * parts, and reading a file is not something a termination-condition test
   * should need a filesystem for (§10).
   */
  readonly attachmentImages?: ReadonlyMap<string, { mediaType: string; data: string }>;
  readonly promptLayers?: SystemPromptLayers;
  /**
   * The classroom's per-turn caps (§10).
   *
   * Defaulted to the Standard preset rather than to "unlimited": Standard is
   * what Appendix A gives a classroom, and a caller that forgets to pass
   * budgets should get the shipped policy, not none.
   */
  readonly budgets?: BudgetSettings;
  readonly tooling?: TurnTooling;
  /** Aborting the turn cancels the upstream request and any running tool (§10). */
  readonly signal?: AbortSignal;
  /** Injectable clock, so the wall-clock cap is testable without waiting. */
  readonly now?: () => number;
}

/** How many times one call may ask the student for input before the loop gives up. */
const MAX_ELICITATION_ROUNDS = 3;

/** Flatten a stored message's parts into the text the dialect sends. */
function textOf(message: Pick<Message, "parts">): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
}

/**
 * Turn one stored message into the messages the dialect sends.
 *
 * A single stored assistant message can carry text, the tools it called and
 * their results, which is three messages upstream — the tree stores a turn as
 * one node, and the wire wants the exchange (§10, §11, §19).
 */
function encodeStoredMessage(
  message: Pick<Message, "role" | "parts">,
  images: RunTurnInput["attachmentImages"],
): GatewayMessage[] {
  const text = textOf(message);
  const toolCalls: GatewayToolCall[] = message.parts
    .filter(
      (part): part is Extract<MessagePart, { type: "tool-call" }> => part.type === "tool-call",
    )
    // A call the student declined never ran, so there is no result to pair with
    // it; replaying it would leave the model waiting on an answer for ever.
    .filter((part) => part.decision !== "declined")
    .map((part) => ({
      id: part.toolCallId,
      name: part.toolName,
      arguments: JSON.stringify(part.arguments ?? {}),
    }));

  const results = message.parts.filter(
    (part): part is Extract<MessagePart, { type: "tool-result" }> => part.type === "tool-result",
  );

  const attachments: GatewayContentPart[] = message.parts
    .filter(
      (part): part is Extract<MessagePart, { type: "attachment" }> => part.type === "attachment",
    )
    .flatMap((part) => {
      const image = images?.get(part.attachmentId);
      return image
        ? [{ type: "image" as const, mediaType: image.mediaType, data: image.data }]
        : [];
    });

  const content: string | GatewayContentPart[] =
    attachments.length > 0 ? [{ type: "text", text }, ...attachments] : text;

  const head: GatewayMessage = {
    role: message.role,
    content,
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
  };

  return [
    head,
    ...results
      .filter((result) => toolCalls.some((call) => call.id === result.toolCallId))
      .map((result) => ({
        role: "tool" as const,
        toolCallId: result.toolCallId,
        content: String(result.result ?? ""),
      })),
  ];
}

/** Assemble the upstream context from the active path plus the layered system prompt (§10). */
export function assembleContext(
  path: readonly Pick<Message, "role" | "parts">[],
  layers?: SystemPromptLayers,
  images?: RunTurnInput["attachmentImages"],
): GatewayMessage[] {
  return [
    { role: "system" as const, content: buildSystemPrompt(layers) },
    ...path.flatMap((message) => encodeStoredMessage(message, images)),
  ];
}

/**
 * Run one turn, yielding normalised events and terminating with exactly one
 * `done`.
 *
 * Every exit is a `done` with a reason rather than a thrown error: the turn is
 * being streamed to a student who must be told what happened in friendly terms,
 * and a transport that has already begun cannot retroactively become a 500.
 */
export async function* runTurn(input: RunTurnInput): AsyncGenerator<GatewayEvent> {
  const messages: GatewayMessage[] = assembleContext(
    input.path,
    input.promptLayers,
    input.attachmentImages,
  );
  const now = input.now ?? Date.now;
  const budget = new TurnBudget(input.budgets ?? BUDGET_PRESETS.standard, now());

  /**
   * Linked to the caller's signal so a per-turn cap cancels the upstream
   * request exactly as an abort does. Without it, a generation that has already
   * blown its token cap keeps costing tokens after the loop stopped reading.
   *
   * A running tool execution reads the same signal, so aborting a turn cancels
   * the call in flight rather than waiting for it (§10).
   */
  const upstream = new AbortController();
  const relayAbort = () => upstream.abort();
  if (input.signal?.aborted) upstream.abort();
  else input.signal?.addEventListener("abort", relayAbort, { once: true });

  let reason: TurnEndReason = "stop";
  const definitions = input.tooling?.tools.definitions() ?? [];

  try {
    while (true) {
      const step = yield* runStep({
        input,
        messages,
        budget,
        now,
        signal: upstream.signal,
        definitions,
      });

      budget.recordStep();

      if (step.stopped) {
        reason = step.stopped;
        if (reason === "budget") upstream.abort();
        break;
      }

      // The zero-tool case, and every turn that ends by the model simply
      // answering: nothing left to execute, so the turn is done.
      if (step.toolCalls.length === 0) break;

      messages.push({
        role: "assistant",
        content: step.text,
        toolCalls: step.toolCalls,
      });

      const outcome = yield* executeCalls({
        input,
        calls: step.toolCalls,
        messages,
        signal: upstream.signal,
      });

      if (outcome) {
        reason = outcome;
        break;
      }

      // A clean boundary: every result is durable and the next model call has
      // not been made. If a cap has been reached, this is where the turn ends
      // with partial content preserved (§10).
      const exceeded = budget.exceeded(now());
      if (exceeded !== null) {
        reason = "budget";
        upstream.abort();
        break;
      }
    }
  } catch (cause) {
    // The abort we issued ourselves surfacing as a cancelled read: the reason is
    // already decided, and a budget stop is not a failure.
    if (isAbort(cause, input.signal)) {
      reason = "aborted";
    } else {
      reason = "error";
      yield {
        type: "error",
        // One student-facing message for every gateway failure; the upstream
        // detail stays in the operator log (§9, §21).
        message: cause instanceof GatewayError ? cause.code : "unavailable",
      };
    }
  } finally {
    input.signal?.removeEventListener("abort", relayAbort);
  }

  yield { type: "done", reason };
}

interface StepOutcome {
  readonly text: string;
  readonly toolCalls: GatewayToolCall[];
  /** Set when the step itself ended the turn. */
  readonly stopped: TurnEndReason | null;
}

/**
 * One model round trip: stream its text, collect the tools it asked for.
 *
 * Separated from the loop because "a step" is exactly the unit the per-turn caps
 * are denominated in, and reading the budget checks beside the streaming is what
 * makes the clean boundary of §10 visible.
 */
async function* runStep(args: {
  input: RunTurnInput;
  messages: readonly GatewayMessage[];
  budget: TurnBudget;
  now: () => number;
  signal: AbortSignal;
  definitions: ReturnType<ToolSet["definitions"]>;
}): AsyncGenerator<GatewayEvent, StepOutcome> {
  const { input, messages, budget, now } = args;

  let text = "";
  const toolCalls: GatewayToolCall[] = [];
  let sawUsage = false;
  /** Whether the request reached the provider at all — see the trailing usage below. */
  let reachedUpstream = false;
  /**
   * The provisional figure already handed to the budget.
   *
   * Estimating each delta on its own would round every fragment up separately,
   * so the same answer would cost more the more finely the gateway sliced it —
   * up to four times more when it streams a character at a time. Estimating the
   * text so far and recording only the increase keeps the running figure equal
   * to one estimate over the whole completion, whatever the chunking.
   */
  let provisional = 0;
  let stopped: TurnEndReason | null = null;

  for await (const event of input.adapter.streamChat(input.dialect, {
    model: input.model,
    messages,
    ...(args.definitions.length > 0 ? { tools: args.definitions } : {}),
    signal: args.signal,
  })) {
    reachedUpstream = true;

    if (event.type === "text-delta") {
      text += event.text;
      // A provisional figure while the step is in flight, so the token cap can
      // bind mid-stream; the gateway's own number supersedes it below.
      const estimate = estimateTokens(text);
      budget.recordProvisionalTokens(estimate - provisional);
      provisional = estimate;
    }
    if (event.type === "usage") {
      sawUsage = true;
      budget.settleStepTokens(event.inputTokens + event.outputTokens);
    }
    if (event.type === "tool-call-started") {
      toolCalls.push({
        id: event.toolCallId,
        name: event.toolName,
        arguments: typeof event.arguments === "string" ? event.arguments : "{}",
      });
      // Held back until the permission mode has been applied: a student in
      // strict mode must see the request, not the announcement (§11).
      continue;
    }

    yield event;

    // The clean boundary §10 asks for: the event just yielded is durable, the
    // student keeps every word that reached them, and nothing further is read.
    if (budget.exceeded(now()) !== null) {
      stopped = "budget";
      break;
    }
  }

  // An abort or a budget stop cuts the dialect off before it reports usage, and
  // those tokens were still spent: usage is never counted as zero (§10).
  if (!sawUsage && reachedUpstream) {
    yield resolveUsage({ promptText: promptTextOf(messages), completionText: text });
  }

  return { text, toolCalls, stopped };
}

/**
 * Apply the permission mode to each call, run the permitted ones, and append
 * their results to the context (§11).
 *
 * Returns a reason when the turn should end, and null when it should continue.
 */
async function* executeCalls(args: {
  input: RunTurnInput;
  calls: readonly GatewayToolCall[];
  messages: GatewayMessage[];
  signal: AbortSignal;
}): AsyncGenerator<GatewayEvent, TurnEndReason | null> {
  const tooling = args.input.tooling;

  for (const call of args.calls) {
    const tool = tooling?.tools.find(call.name);

    if (!tooling || !tool) {
      // The model named something outside this classroom's allowlist. Refused
      // by construction rather than by a check anyone could forget (§11, §21).
      yield* emitResult(
        args.messages,
        call,
        "That tool is not available. Continue without it.",
        true,
      );
      continue;
    }

    const decision = yield* decide({ tooling, tool, call, signal: args.signal });

    if (decision !== "approved") {
      const refusal = decision === "declined" ? DECLINED_RESULT : UNANSWERED_RESULT;
      yield {
        type: "tool-result",
        toolCallId: call.id,
        result: refusal,
        isError: true,
        decision,
      };
      args.messages.push({ role: "tool", toolCallId: call.id, content: refusal });
      // A declined call returns a refusal and the loop continues (§11); an
      // unanswered one does the same, so a closed tab cannot hang a turn.
      continue;
    }

    yield {
      type: "tool-call-started",
      toolCallId: call.id,
      toolName: tool.name,
      serverLabel: tool.serverLabel,
      arguments: parseArguments(call.arguments),
    };

    let execution = await executeTool({
      context: tooling.context,
      tool,
      arguments: parseArguments(call.arguments),
      signal: args.signal,
    });

    // "An interim result requesting input is surfaced to the student by default…
    // and the original request is retried with the responses attached" (§11).
    for (let round = 0; execution.elicitation && round < MAX_ELICITATION_ROUNDS; round++) {
      const answer = yield* elicit({
        tooling,
        tool,
        call,
        elicitation: execution.elicitation,
        signal: args.signal,
      });

      if (!answer) {
        execution = {
          text: "The pupil did not answer the question this tool asked. Continue without it.",
          isError: true,
        };
        break;
      }

      execution = await executeTool({
        context: tooling.context,
        tool,
        arguments: parseArguments(call.arguments),
        elicitationResponse: answer,
        signal: args.signal,
      });
    }

    if (execution.imageId) {
      yield { type: "image-generated", imageId: execution.imageId, prompt: execution.prompt ?? "" };
    }

    yield* emitResult(args.messages, call, execution.text, execution.isError);
  }

  return null;
}

/** Yield the result event and append the matching upstream message. */
function* emitResult(
  messages: GatewayMessage[],
  call: GatewayToolCall,
  text: string,
  isError: boolean,
): Generator<GatewayEvent> {
  yield { type: "tool-result", toolCallId: call.id, result: text, isError };
  messages.push({ role: "tool", toolCallId: call.id, content: text });
}

/** Apply the classroom's permission mode, asking the student when it says to (§11). */
async function* decide(args: {
  tooling: TurnTooling;
  tool: NonNullable<ReturnType<ToolSet["find"]>>;
  call: GatewayToolCall;
  signal: AbortSignal;
}): AsyncGenerator<GatewayEvent, PermissionDecision> {
  const { tooling, tool, call } = args;

  if (!requiresPermission(tooling.mode, tool)) return "approved";

  yield {
    type: "permission-request",
    toolCallId: call.id,
    toolName: tool.name,
    serverLabel: tool.serverLabel,
    sensitive: tool.sensitive,
    arguments: parseArguments(call.arguments),
  };

  const answer = await tooling.interactions.wait({
    turnId: tooling.turnId,
    requestId: call.id,
    timeoutMs: waitTimeout(args),
    signal: args.signal,
  });

  if (answer?.kind !== "permission") return "unanswered";
  return answer.approved ? "approved" : "declined";
}

/** Surface an interim request for input and collect the student's answers (§11). */
async function* elicit(args: {
  tooling: TurnTooling;
  tool: NonNullable<ReturnType<ToolSet["find"]>>;
  call: GatewayToolCall;
  elicitation: NonNullable<Awaited<ReturnType<typeof executeTool>>["elicitation"]>;
  signal: AbortSignal;
}): AsyncGenerator<GatewayEvent, Record<string, unknown> | null> {
  const { tooling, tool, call } = args;

  yield {
    type: "elicitation-request",
    toolCallId: call.id,
    toolName: tool.name,
    serverLabel: tool.serverLabel,
    message: args.elicitation.message,
    fields: args.elicitation.fields,
  };

  const answer: InteractionAnswer | null = await tooling.interactions.wait({
    turnId: tooling.turnId,
    requestId: call.id,
    timeoutMs: waitTimeout(args),
    signal: args.signal,
  });

  if (answer?.kind !== "elicitation" || answer.declined) return null;
  return { ...answer.values };
}

/**
 * How long a question may wait.
 *
 * Bounded by the turn's own wall-clock cap: a question that outlived the turn it
 * belongs to would be answered into nothing, and the pupil would be looking at a
 * form that no longer does anything (§10, §11).
 */
function waitTimeout(args: { tooling: TurnTooling }): number {
  return (args.tooling.context.classroom.perTurnWallClockSeconds ?? 300) * 1000;
}

function parseArguments(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    // A model that emitted malformed arguments is told so by the tool, which is
    // more useful to it than a failed turn.
    return {};
  }
}

function isAbort(cause: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  return cause instanceof Error && cause.name === "AbortError";
}
