import type { Message } from "../db/schema";
import type { DialectName, GatewayAdapter } from "../gateway/adapter";
import type { GatewayMessage } from "../gateway/dialect";
import { GatewayError } from "../gateway/errors";
import type { GatewayEvent, TurnEndReason } from "../gateway/events";
import { estimateTokens, resolveUsage } from "../gateway/usage";
import { BUDGET_PRESETS, type BudgetSettings, TurnBudget } from "./budgets";
import { buildSystemPrompt, type SystemPromptLayers } from "./system-prompt";

/**
 * The agent loop (PRD §10).
 *
 * "Assemble context, call the model, stream deltas to the client, execute any
 * requested tools, append results, repeat until the model stops or a budget is
 * exhausted. Plain chat is the zero-tool case."
 *
 * M1 is that zero-tool case: one gateway call per turn. Tool execution slots
 * into the marked point in Phase 3.6. The per-turn budget layer of §10 is
 * enforced here — this is the only place that knows where a clean boundary is.
 */

export interface RunTurnInput {
  readonly adapter: GatewayAdapter;
  readonly dialect: DialectName;
  readonly model: string;
  /** The active path of the message tree, oldest first (§10). */
  readonly path: readonly Pick<Message, "role" | "parts">[];
  readonly promptLayers?: SystemPromptLayers;
  /**
   * The classroom's per-turn caps (§10).
   *
   * Defaulted to the Standard preset rather than to "unlimited": Standard is
   * what Appendix A gives a classroom, and a caller that forgets to pass
   * budgets should get the shipped policy, not none.
   */
  readonly budgets?: BudgetSettings;
  /** Aborting the turn cancels the upstream request (§10). */
  readonly signal?: AbortSignal;
  /** Injectable clock, so the wall-clock cap is testable without waiting. */
  readonly now?: () => number;
}

/** Flatten a stored message's parts into the text the dialect sends. */
function textOf(message: Pick<Message, "parts">): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
}

/** Assemble the upstream context from the active path plus the layered system prompt (§10). */
export function assembleContext(
  path: readonly Pick<Message, "role" | "parts">[],
  layers?: SystemPromptLayers,
): GatewayMessage[] {
  return [
    { role: "system" as const, content: buildSystemPrompt(layers) },
    ...path.map((message) => ({ role: message.role, content: textOf(message) })),
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
  const messages = assembleContext(input.path, input.promptLayers);
  const now = input.now ?? Date.now;
  const budget = new TurnBudget(input.budgets ?? BUDGET_PRESETS.standard, now());

  /**
   * Linked to the caller's signal so a per-turn cap cancels the upstream
   * request exactly as an abort does. Without it, a generation that has already
   * blown its token cap keeps costing tokens after the loop stopped reading.
   */
  const upstream = new AbortController();
  const relayAbort = () => upstream.abort();
  if (input.signal?.aborted) upstream.abort();
  else input.signal?.addEventListener("abort", relayAbort, { once: true });

  let reason: TurnEndReason = "stop";
  let completion = "";
  let sawUsage = false;
  /** Whether the request reached the provider at all — see `trailingUsage`. */
  let reachedUpstream = false;

  try {
    for await (const event of input.adapter.streamChat(input.dialect, {
      model: input.model,
      messages,
      signal: upstream.signal,
    })) {
      reachedUpstream = true;

      if (event.type === "text-delta") {
        completion += event.text;
        // A provisional figure while the step is in flight, so the token cap can
        // bind mid-stream; the gateway's own number supersedes it below.
        budget.recordProvisionalTokens(estimateTokens(event.text));
      }
      if (event.type === "usage") {
        sawUsage = true;
        budget.settleStepTokens(event.inputTokens + event.outputTokens);
      }

      yield event;

      // The clean boundary §10 asks for: the event just yielded is durable, the
      // student keeps every word that reached them, and nothing further is read.
      if (budget.exceeded(now()) !== null) {
        reason = "budget";
        upstream.abort();
        break;
      }
    }

    budget.recordStep();

    // Phase 3.6 continues the loop here: if the model requested tools, execute
    // the permitted ones, append their results, and call the adapter again —
    // re-checking `budget.exceeded()` before each further call. The zero-tool
    // case terminates as soon as the model stops.
  } catch (cause) {
    // The abort we issued ourselves surfacing as a cancelled read: the reason is
    // already decided, and a budget stop is not a failure.
    if (reason !== "budget") {
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
    }
  } finally {
    input.signal?.removeEventListener("abort", relayAbort);
  }

  // An abort or a budget stop cuts the dialect off before it reports usage, and
  // those tokens were still spent: usage is never counted as zero (§10).
  if (!sawUsage && reachedUpstream) {
    yield resolveUsage({
      promptText: messages.map((message) => message.content).join("\n"),
      completionText: completion,
    });
  }

  yield { type: "done", reason };
}

function isAbort(cause: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  return cause instanceof Error && cause.name === "AbortError";
}
