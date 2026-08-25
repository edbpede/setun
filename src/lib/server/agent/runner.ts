import { classroomStateChannel } from "../classroom/state-channel";
import type { AppDatabase } from "../db/client";
import { setActiveLeaf } from "../db/queries/conversations";
import { attachImageToMessage } from "../db/queries/images";
import { appendMessage, recordMessageUsage } from "../db/queries/messages";
import { finishTurn } from "../db/queries/turns";
import { recordUsageEvent } from "../db/queries/usage";
import type { Message, MessagePart, ModelAlias, PermissionMode } from "../db/schema";
import type { GatewayAdapter } from "../gateway/adapter";
import type { GatewayEvent } from "../gateway/events";
import { describeCause, log } from "../logging";
import { recordTurnArtifacts } from "./artifacts";
import type { BudgetSettings } from "./budgets";
import { turnInteractions } from "./interactions";
import { liveTurns } from "./live-turns";
import { runTurn } from "./loop";
import type { SystemPromptLayers } from "./system-prompt";
import type { ToolContext, ToolSet } from "./tools";
import { TurnBuffer } from "./turn-buffer";

/**
 * Turn execution: the loop wired to persistence and the live registry (PRD §10).
 *
 * Runs detached from the request that started it. A student who closes the tab
 * mid-turn must be able to resume it, which cannot work if the turn's lifetime
 * is the HTTP request's — so the endpoint starts this and then merely tails it,
 * exactly as a resume does.
 *
 * What the turn produced is derived from the event stream rather than tracked
 * alongside it, so a resumed turn replaying the buffer reconstructs exactly what
 * a live one persisted (§10, §11).
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
  readonly attachmentImages?: ReadonlyMap<string, { mediaType: string; data: string }>;
  readonly promptLayers?: SystemPromptLayers;
  /** The classroom's per-turn caps; the loop stops the turn at a clean boundary (§10). */
  readonly budgets?: BudgetSettings;
  /** The turn's tools and the mode that governs them; absent for plain chat (§11). */
  readonly tools?: ToolSet;
  readonly toolContext?: ToolContext;
  readonly permissionMode?: PermissionMode;
}

interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  estimated: boolean;
  toolCalls: number;
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

  const parts: MessagePart[] = [];
  const imageIds: string[] = [];
  const usage: TurnUsage = { inputTokens: 0, outputTokens: 0, estimated: false, toolCalls: 0 };
  let status: "completed" | "aborted" | "failed" = "completed";
  /** Calls the student was asked about, so the result can record what they said (§19). */
  const asked = new Map<string, number>();

  try {
    for await (const event of runTurn({
      adapter: input.adapter,
      dialect: input.alias.dialect,
      model: input.alias.gatewayModelId,
      path: input.path,
      attachmentImages: input.attachmentImages,
      promptLayers: input.promptLayers,
      budgets: input.budgets,
      signal,
      ...(input.tools && input.toolContext
        ? {
            tooling: {
              tools: input.tools,
              context: input.toolContext,
              mode: input.permissionMode ?? "standard",
              turnId,
              interactions: turnInteractions,
            },
          }
        : {}),
    })) {
      collect({ event, parts, imageIds, usage, asked });

      if (event.type === "done") status = terminalStatusFor(event);

      // Persist first, then publish: a tailing subscriber must never see an
      // event that a resuming reader could miss (§10).
      const buffered = buffer.append(event);
      liveTurns.publish({ turnId, buffered });
    }

    persistOutcome({ ...input, parts, imageIds, usage, status });
  } catch (cause) {
    // The loop converts failures into events, so reaching here means the
    // persistence path itself failed. Terminate the turn rather than leaving a
    // row that resume would wait on forever.
    buffer.append({ type: "error", message: "unavailable" });
    buffer.append({ type: "done", reason: "error" });
    finishTurn(db, { turnId, status: "failed" });
    log.error("turn execution failed", { turnId, cause: describeCause(cause) });
  } finally {
    liveTurns.end(turnId);
  }
}

/**
 * Fold one event into what the turn produced.
 *
 * Text accumulates into a single trailing part rather than one part per delta:
 * a message of ten thousand one-character parts is the same message and a much
 * worse row.
 */
function collect(args: {
  event: GatewayEvent;
  parts: MessagePart[];
  imageIds: string[];
  usage: TurnUsage;
  /** Index in `parts` of each call the student was asked about. */
  asked: Map<string, number>;
}): void {
  const { event, parts } = args;

  switch (event.type) {
    case "text-delta": {
      const last = parts.at(-1);
      if (last?.type === "text") {
        parts[parts.length - 1] = { type: "text", text: last.text + event.text };
      } else {
        parts.push({ type: "text", text: event.text });
      }
      break;
    }
    case "permission-request": {
      // The call is recorded the moment it is asked about, so a declined one is
      // in the transcript at all — no `tool-call-started` ever follows it (§19).
      args.asked.set(event.toolCallId, parts.length);
      parts.push({
        type: "tool-call",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        serverLabel: event.serverLabel ?? null,
        arguments: event.arguments,
        decision: "approved",
      });
      break;
    }
    case "tool-call-started": {
      args.usage.toolCalls++;
      // A call that was asked about is already in the list, with the arguments
      // the student saw; one the mode ran without asking is added here.
      if (args.asked.has(event.toolCallId)) break;

      parts.push({
        type: "tool-call",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        serverLabel: event.serverLabel ?? null,
        arguments: event.arguments,
        decision: "auto",
      });
      break;
    }
    case "tool-result": {
      // The parts are read-only by type, so a decision that turned out to be a
      // refusal replaces the entry rather than mutating it.
      const index = args.asked.get(event.toolCallId);
      const call = index === undefined ? undefined : parts[index];
      if (index !== undefined && call?.type === "tool-call" && event.decision) {
        parts[index] = { ...call, decision: event.decision };
      }

      parts.push({
        type: "tool-result",
        toolCallId: event.toolCallId,
        result: event.result,
        isError: event.isError,
      });
      break;
    }
    case "image-generated":
      args.imageIds.push(event.imageId);
      parts.push({ type: "generated-image", imageId: event.imageId, prompt: event.prompt });
      break;
    case "usage":
      // Summed across steps: a turn that called three tools made four model
      // round trips, and all four were paid for (§10).
      args.usage.inputTokens += event.inputTokens;
      args.usage.outputTokens += event.outputTokens;
      args.usage.estimated ||= event.estimated;
      break;
    default:
      break;
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
    parts: MessagePart[];
    imageIds: string[];
    usage: TurnUsage;
    status: "completed" | "aborted" | "failed";
  },
): void {
  const { db } = input;
  const spent = input.usage.inputTokens + input.usage.outputTokens;

  const assistantMessage =
    input.parts.length > 0
      ? appendMessage(db, {
          conversationId: input.conversationId,
          parentId: input.parentMessageId,
          role: "assistant",
          parts: input.parts,
        })
      : null;

  // Recorded before usage and the active leaf: a creation outlives the
  // conversation that produced it, so it becomes a row of its own the moment the
  // model writes it rather than only when something later reads the message (§13, §16).
  if (assistantMessage) {
    recordTurnArtifacts(db, {
      studentId: input.studentId,
      conversationId: input.conversationId,
      messageId: assistantMessage.id,
      parts: input.parts,
    });
  }

  if (assistantMessage && spent > 0) {
    recordMessageUsage(db, {
      messageId: assistantMessage.id,
      inputTokens: input.usage.inputTokens,
      outputTokens: input.usage.outputTokens,
      estimated: input.usage.estimated,
    });

    // Images generated during the turn outlive the conversation, but while it
    // exists they belong to the message that produced them (§16).
    for (const imageId of input.imageIds) {
      attachImageToMessage(db, { imageId, messageId: assistantMessage.id });
    }
  }

  // Usage is recorded even for an aborted turn: the tokens were spent (§10).
  if (spent > 0) {
    recordUsageEvent(db, {
      classroomId: input.classroomId,
      studentId: input.studentId,
      modelAliasId: input.alias.id,
      inputTokens: input.usage.inputTokens,
      outputTokens: input.usage.outputTokens,
      toolCalls: input.usage.toolCalls,
      estimated: input.usage.estimated,
    });

    // The allowance just moved, so every tab watching this classroom is told —
    // without which a pupil's own meter would lag by up to a poll interval (§8).
    classroomStateChannel.publish(input.classroomId);
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
