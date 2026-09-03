import { fenceFor } from "../../artifacts/fences";
import { fenceInfo } from "../../artifacts/identity";
import { isArtifactLanguage } from "../../artifacts/types";
import type { Message, MessagePart, PermissionMode } from "../db/schema";
import type { DialectName, GatewayAdapter } from "../gateway/adapter";
import type { GatewayContentPart, GatewayMessage, GatewayToolCall } from "../gateway/dialect";
import { GatewayError } from "../gateway/errors";
import type { GatewayEvent, TurnEndReason } from "../gateway/events";
import { promptTextOf } from "../gateway/messages";
import { estimateTokens, resolveUsage } from "../gateway/usage";
import type { AttachmentPayload } from "../storage/attachments";
import {
  type ArtifactContext,
  elideSupersededArtifacts,
  formatArtifactState,
  formatCarriedSources,
} from "./artifact-context";
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
   * Attachments, already read from storage: images base64-encoded,
   * text/code files decoded to the fenced text the message sends.
   *
   * Resolved by the caller rather than here: the loop stays pure over stored
   * parts, and reading a file is not something a termination-condition test
   * should need a filesystem for (§10).
   */
  readonly attachmentPayloads?: ReadonlyMap<string, AttachmentPayload>;
  readonly promptLayers?: SystemPromptLayers;
  /**
   * What this conversation has built, for the state note and the elision (§13).
   *
   * Resolved by the caller rather than here, exactly as attachments are: the
   * loop stays pure over stored parts, and a termination-condition test should
   * not need a database to run.
   */
  readonly artifacts?: ArtifactContext;
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

/**
 * Flatten a stored message's parts into the text the dialect sends.
 *
 * An artifact the student edited travels as a marked fenced block rather than as
 * bare prose: the model has to be able to tell the pupil's current source from
 * the version it wrote itself, which is the whole point of carrying it (§13).
 * The marker is addressed to the model, so it is not a Paraglide message.
 */
function textOf(message: Pick<Message, "parts">): string {
  return message.parts
    .filter(
      (part): part is Extract<MessagePart, { type: "text" | "artifact-edit" }> =>
        part.type === "text" || part.type === "artifact-edit",
    )
    .map((part) => (part.type === "text" ? part.text : encodeArtifactEdit(part)))
    .join("");
}

/**
 * The marked block an edited artifact travels in (§13).
 *
 * The fence carries the artifact's own id, in the form the model is asked to
 * write, and the marker says outright what to do with it: a pupil's edited page
 * that comes back under `id=home-page` is answerable with a complete file under
 * the same id, which is the whole mechanism. A part stored before the id existed
 * has none, and encodes in the form it was written in.
 */
function encodeArtifactEdit(part: Extract<MessagePart, { type: "artifact-edit" }>): string {
  const named = part.title ? ` "${part.title}"` : "";
  const key = part.key ?? null;
  const info =
    key && isArtifactLanguage(part.language)
      ? fenceInfo(part.language, { key, title: part.title })
      : part.language;

  // Long enough for this source: a page that explains markdown holds a line of
  // three backticks, which would close a three-backtick fence early and send the
  // rest of the pupil's file to the model as prose.
  const fence = fenceFor(part.source);

  return [
    "",
    "",
    `[The student's edited version of the ${part.language} artifact${named}.`,
    "This is the current source, not the version you last wrote.",
    ...(key ? [`To change it, reuse id=${key} and write the complete file.]`] : ["]"]),
    `${fence}${info}`,
    part.source,
    fence,
  ].join("\n");
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
  payloads: RunTurnInput["attachmentPayloads"],
): GatewayMessage[] {
  const text = textOf(message);
  const toolCalls: GatewayToolCall[] = message.parts
    .filter(
      (part): part is Extract<MessagePart, { type: "tool-call" }> => part.type === "tool-call",
    )
    // Calls the student declined are replayed too, paired with the refusal that
    // was returned for them: the model asked, and being told plainly that it was
    // refused is what stops it asking again on the next turn (§11).
    .map((part) => ({
      id: part.toolCallId,
      name: part.toolName,
      arguments: JSON.stringify(part.arguments ?? {}),
    }));

  const results = message.parts.filter(
    (part): part is Extract<MessagePart, { type: "tool-result" }> => part.type === "tool-result",
  );

  const attachmentParts = message.parts.filter(
    (part): part is Extract<MessagePart, { type: "attachment" }> => part.type === "attachment",
  );

  // Text and code files travel inline as part of the message text (they were
  // stored already fenced), so the model reads them the same way it reads what
  // the pupil typed. Images travel as their own content part (§10).
  const imageParts: GatewayContentPart[] = attachmentParts.flatMap((part) => {
    const payload = payloads?.get(part.attachmentId);
    return payload?.kind === "image"
      ? [{ type: "image" as const, mediaType: payload.mediaType, data: payload.data }]
      : [];
  });

  const inlinedText = attachmentParts
    .map((part) => payloads?.get(part.attachmentId))
    .filter(
      (payload): payload is Extract<AttachmentPayload, { kind: "text" }> =>
        payload?.kind === "text",
    )
    .map((payload) => payload.text);

  const fullText = [text, ...inlinedText].filter((chunk) => chunk.length > 0).join("\n\n");

  const content: string | GatewayContentPart[] =
    imageParts.length > 0 ? [{ type: "text", text: fullText }, ...imageParts] : fullText;

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

/**
 * Assemble the upstream context from the active path plus the layered system
 * prompt (§10, §13).
 *
 * Two things happen to the path on the way. Obsolete copies of an artifact's
 * source are replaced by a line naming them, so a fourth revision of a page does
 * not send four copies of that page. Then the state note is appended to the last
 * user message, so the model reads what exists immediately before the request
 * that asks it to change one of them.
 *
 * Behind the note travel the sources the path does not hold. An artifact whose
 * current revision sits on another branch of the message tree — which is what a
 * pupil editing an earlier prompt produces — is named by the note and present
 * nowhere, so the model would rewrite it from the last copy it can see. They go
 * in the same slot for the same reasons.
 *
 * The note is not a system message: it changes every turn, and putting it in the
 * system layer would break the cacheable prefix on every send. It is not
 * persisted either — it describes the moment the turn was assembled.
 */
export function assembleContext(
  path: readonly Pick<Message, "role" | "parts">[],
  layers?: SystemPromptLayers,
  payloads?: RunTurnInput["attachmentPayloads"],
  artifacts?: ArtifactContext,
): GatewayMessage[] {
  const elided = artifacts ? elideSupersededArtifacts(path, artifacts.index) : path;

  const messages: GatewayMessage[] = [
    { role: "system" as const, content: buildSystemPrompt(layers) },
    ...elided.flatMap((message) => encodeStoredMessage(message, payloads)),
  ];

  const note = artifacts
    ? [formatArtifactState(artifacts.state), formatCarriedSources(artifacts.carried)]
        .filter((part): part is string => part !== null)
        .join("\n\n")
    : "";
  return note ? withStateNote(messages, note) : messages;
}

/** Append the note to the last user message, whatever shape its content has. */
function withStateNote(messages: GatewayMessage[], note: string): GatewayMessage[] {
  const at = messages.findLastIndex((message) => message.role === "user");
  if (at === -1) return messages;

  const target = messages[at];

  if (typeof target.content === "string") {
    messages[at] = { ...target, content: `${target.content}\n\n${note}` };
    return messages;
  }

  // A message with images carries its prose as the first text part.
  const content = [...target.content];
  const textAt = content.findIndex((part) => part.type === "text");
  const held = textAt === -1 ? null : content[textAt];
  if (held?.type === "text") content[textAt] = { type: "text", text: `${held.text}\n\n${note}` };
  else content.unshift({ type: "text", text: note });

  messages[at] = { ...target, content };
  return messages;
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
    input.attachmentPayloads,
    input.artifacts,
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
        budget,
        now,
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

  try {
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
  } catch (cause) {
    /**
     * A cancelled read leaves this loop by *throwing*, not by breaking, so the
     * trailing usage below is never reached — which is how an aborted turn came
     * to be recorded as costing nothing at all. The tokens were spent: the
     * gateway generated them and the pupil read them. Account for what was
     * produced before the cancellation, then let the abort carry on to
     * `runTurn`, which is where it decides the turn ended `aborted`.
     *
     * A budget stop breaks out normally and settles below; only this path was
     * losing the figure.
     */
    if (!sawUsage && reachedUpstream) {
      yield resolveUsage({ promptText: promptTextOf(messages), completionText: text });
    }
    throw cause;
  }

  // A budget stop cuts the dialect off before it reports usage, and those tokens
  // were still spent: usage is never counted as zero (§10).
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
  budget: TurnBudget;
  now: () => number;
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

    const decision = yield* decide({
      tooling,
      tool,
      call,
      signal: args.signal,
      budget: args.budget,
      now: args.now,
    });

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
        budget: args.budget,
        now: args.now,
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
  budget: TurnBudget;
  now: () => number;
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
  budget: TurnBudget;
  now: () => number;
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
 * What is left of the turn's wall-clock cap, not the whole of it. A question
 * that outlived the turn it belongs to would be answered into nothing, and the
 * pupil would be looking at a form that no longer does anything; giving each
 * wait the full cap restarts it, so one permission and three elicitation rounds
 * keep a five-minute turn alive for twenty (§10, §11).
 *
 * Reaching zero is not a special case: the wait resolves unanswered, the call
 * returns a refusal, and the loop stops at its next clean boundary.
 */
function waitTimeout(args: { budget: TurnBudget; now: () => number }): number {
  return args.budget.remainingWallClockMs(args.now());
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
