import type { AppDatabase } from "../db/client";
import { setActiveLeaf } from "../db/queries/conversations";
import { appendMessage, recordMessageUsage } from "../db/queries/messages";
import { finishTurn } from "../db/queries/turns";
import { recordUsageEvent } from "../db/queries/usage";
import type { Message, ModelAlias } from "../db/schema";
import type { GatewayAdapter } from "../gateway/adapter";
import type { GatewayEvent } from "../gateway/events";
import { liveTurns } from "./live-turns";
import { runTurn } from "./loop";
import type { SystemPromptLayers } from "./system-prompt";
import { TurnBuffer } from "./turn-buffer";

/**
 * Turn execution: the loop wired to persistence and the live registry (PRD §10).
 *
 * Runs detached from the request that started it. A student who closes the tab
 * mid-turn must be able to resume it, which cannot work if the turn's lifetime
 * is the HTTP request's — so the endpoint starts this and then merely tails it,
 * exactly as a resume does.
 */

export interface ExecuteTurnInput {
  readonly db: AppDatabase;
  readonly adapter: GatewayAdapter;
  readonly turnId: string;
  readonly conversationId: string;
  readonly studentId: string;
  readonly classroomId: string;
  readonly alias: ModelAlias;
  readonly parentMessageId: string | null;
  readonly path: readonly Pick<Message, "role" | "parts">[];
  readonly promptLayers?: SystemPromptLayers;
}

/**
 * Execute a turn to completion, buffering every event.
 *
 * Resolves when the turn reaches a terminal state; the caller may ignore the
 * promise, and the endpoint does.
 */
export async function executeTurn(input: ExecuteTurnInput): Promise<void> {
  const { db, turnId } = input;
  const signal = liveTurns.register(turnId);
  const buffer = new TurnBuffer(db, turnId);

  let text = "";
  let usage: { inputTokens: number; outputTokens: number; estimated: boolean } | null = null;
  let status: "completed" | "aborted" | "failed" = "completed";

  try {
    for await (const event of runTurn({
      adapter: input.adapter,
      dialect: input.alias.dialect,
      model: input.alias.gatewayModelId,
      path: input.path,
      promptLayers: input.promptLayers,
      signal,
    })) {
      if (event.type === "text-delta") text += event.text;
      if (event.type === "usage") {
        usage = {
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
          estimated: event.estimated,
        };
      }
      if (event.type === "done") {
        status = terminalStatusFor(event);
      }

      // Persist first, then publish: a tailing subscriber must never see an
      // event that a resuming reader could miss (§10).
      const buffered = buffer.append(event);
      liveTurns.publish({ turnId, buffered });
    }

    persistOutcome({ ...input, text, usage, status });
  } catch (cause) {
    // The loop converts failures into events, so reaching here means the
    // persistence path itself failed. Terminate the turn rather than leaving a
    // row that resume would wait on forever.
    buffer.append({ type: "error", message: "unavailable" });
    buffer.append({ type: "done", reason: "error" });
    finishTurn(db, { turnId, status: "failed" });
    console.error("turn execution failed", { turnId, cause: describe(cause) });
  } finally {
    liveTurns.end(turnId);
  }
}

function terminalStatusFor(event: Extract<GatewayEvent, { type: "done" }>) {
  if (event.reason === "aborted") return "aborted" as const;
  if (event.reason === "error") return "failed" as const;
  return "completed" as const;
}

/**
 * Write what the turn produced.
 *
 * An aborted turn still persists its partial text: the student saw those words
 * stream, and a reload must not silently delete them (§10, §13).
 */
function persistOutcome(
  input: ExecuteTurnInput & {
    text: string;
    usage: { inputTokens: number; outputTokens: number; estimated: boolean } | null;
    status: "completed" | "aborted" | "failed";
  },
): void {
  const { db } = input;
  const hasContent = input.text.length > 0;

  const assistantMessage = hasContent
    ? appendMessage(db, {
        conversationId: input.conversationId,
        parentId: input.parentMessageId,
        role: "assistant",
        parts: [{ type: "text", text: input.text }],
      })
    : null;

  if (assistantMessage && input.usage) {
    recordMessageUsage(db, {
      messageId: assistantMessage.id,
      inputTokens: input.usage.inputTokens,
      outputTokens: input.usage.outputTokens,
      estimated: input.usage.estimated,
    });
  }

  // Usage is recorded even for an aborted turn: the tokens were spent (§10).
  if (input.usage) {
    recordUsageEvent(db, {
      classroomId: input.classroomId,
      studentId: input.studentId,
      modelAliasId: input.alias.id,
      inputTokens: input.usage.inputTokens,
      outputTokens: input.usage.outputTokens,
      estimated: input.usage.estimated,
    });
  }

  if (assistantMessage) {
    setActiveLeaf(db, {
      conversationId: input.conversationId,
      studentId: input.studentId,
      messageId: assistantMessage.id,
    });
  }

  finishTurn(db, {
    turnId: input.turnId,
    status: input.status,
    assistantMessageId: assistantMessage?.id ?? null,
  });
}

/** Errors are logged without stack traces or infrastructure detail (§16, §21). */
function describe(cause: unknown): string {
  return cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
}
