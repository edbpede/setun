import type { Message } from "../db/schema";
import type { DialectName, GatewayAdapter } from "../gateway/adapter";
import type { GatewayMessage } from "../gateway/dialect";
import { GatewayError } from "../gateway/errors";
import type { GatewayEvent, TurnEndReason } from "../gateway/events";
import { buildSystemPrompt, type SystemPromptLayers } from "./system-prompt";

/**
 * The agent loop (PRD §10).
 *
 * "Assemble context, call the model, stream deltas to the client, execute any
 * requested tools, append results, repeat until the model stops or a budget is
 * exhausted. Plain chat is the zero-tool case."
 *
 * M1 is that zero-tool case: one gateway call per turn. Tool execution slots
 * into the marked point in Phase 3.6 and budget enforcement into Phase 2.7 —
 * the loop already terminates on a single `done` event carrying a reason, which
 * is the shape both need.
 */

export interface RunTurnInput {
  readonly adapter: GatewayAdapter;
  readonly dialect: DialectName;
  readonly model: string;
  /** The active path of the message tree, oldest first (§10). */
  readonly path: readonly Pick<Message, "role" | "parts">[];
  readonly promptLayers?: SystemPromptLayers;
  /** Aborting the turn cancels the upstream request (§10). */
  readonly signal?: AbortSignal;
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

  let reason: TurnEndReason = "stop";

  try {
    for await (const event of input.adapter.streamChat(input.dialect, {
      model: input.model,
      messages,
      signal: input.signal,
    })) {
      yield event;
    }

    // Phase 3.6 continues the loop here: if the model requested tools, execute
    // the permitted ones, append their results, and call the adapter again.
    // The zero-tool case terminates as soon as the model stops.
  } catch (cause) {
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

  yield { type: "done", reason };
}

function isAbort(cause: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  return cause instanceof Error && cause.name === "AbortError";
}
