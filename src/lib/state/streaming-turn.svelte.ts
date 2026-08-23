import type { MessagePart } from "$lib/server/db/schema";
import type { ElicitationFieldSpec, GatewayEvent } from "$lib/server/gateway/events";

/**
 * The in-flight turn, client side (PRD §10, §11).
 *
 * A container class rather than bare exported `let`s, so reactivity survives the
 * import boundary — and instantiated per session through context rather than as
 * a module singleton, because a module singleton is shared across every SSR
 * request on the server.
 *
 * The turn is accumulated as the same `MessagePart[]` the server persists, so a
 * turn being watched live and the same turn after a reload render through one
 * component and cannot drift apart. Both are folded from the same normalised
 * event stream; neither is derived from the other (§10).
 *
 * Types only from server modules. Types are erased at compile time, so this does
 * not pull a server module into the client bundle; it is the same normalised
 * contract on both sides of the wire.
 */

/** Why the last turn ended, when it ended in a way worth telling the student. */
export type TurnNotice = "aborted" | "interrupted" | "error" | "budget" | "unanswered" | null;

/** A tool call waiting on the student's yes or no (§11). */
export interface PendingPermission {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly serverLabel: string | null;
  readonly sensitive: boolean;
  readonly arguments: unknown;
}

/** A tool call waiting on the student's answers (§11). */
export interface PendingElicitation {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly serverLabel: string | null;
  readonly message: string;
  readonly fields: readonly ElicitationFieldSpec[];
}

export class StreamingTurn {
  /** The turn so far, in the order it happened. Plain text while streaming (§20). */
  parts = $state<MessagePart[]>([]);
  turnId = $state<string | null>(null);
  /** Last sequence number applied — the cursor a resume continues from (§10). */
  lastSeq = $state(-1);
  notice = $state<TurnNotice>(null);
  /** At most one question is open at a time: the loop asks and then waits (§11). */
  permission = $state<PendingPermission | null>(null);
  elicitation = $state<PendingElicitation | null>(null);
  #streaming = $state(false);

  get streaming(): boolean {
    return this.#streaming;
  }

  /** The prose so far, for the plain-text render while the turn streams (§20). */
  get text(): string {
    return this.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
  }

  get isEmpty(): boolean {
    return this.parts.length === 0;
  }

  /** Whether anything is waiting on the student right now. */
  get waiting(): boolean {
    return this.permission !== null || this.elicitation !== null;
  }

  begin(turnId: string): void {
    this.turnId = turnId;
    this.parts = [];
    this.lastSeq = -1;
    this.notice = null;
    this.permission = null;
    this.elicitation = null;
    this.#streaming = true;
  }

  /** Resume an existing turn, keeping any text already rendered. */
  resume(turnId: string, afterSeq: number): void {
    this.turnId = turnId;
    this.lastSeq = afterSeq;
    this.notice = null;
    this.#streaming = true;
  }

  /**
   * Apply one normalised event.
   *
   * Events at or below the cursor are ignored, so a resume that overlaps what
   * the tab already rendered cannot duplicate text (§10).
   */
  apply(event: GatewayEvent, seq: number): void {
    if (seq <= this.lastSeq) return;
    this.lastSeq = seq;

    switch (event.type) {
      case "text-delta":
        this.#appendText(event.text);
        break;

      case "permission-request":
        this.permission = {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          serverLabel: event.serverLabel ?? null,
          sensitive: event.sensitive,
          arguments: event.arguments,
        };
        break;

      case "elicitation-request":
        this.elicitation = {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          serverLabel: event.serverLabel ?? null,
          message: event.message,
          fields: event.fields,
        };
        break;

      case "tool-call-started":
        this.permission = null;
        this.parts = [
          ...this.parts,
          {
            type: "tool-call",
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            serverLabel: event.serverLabel ?? null,
            arguments: event.arguments,
            decision: "auto",
          },
        ];
        break;

      case "tool-result": {
        // A call refused by the permission mode never announced itself, so the
        // result is the first the transcript hears of it.
        const announced = this.parts.some(
          (part) => part.type === "tool-call" && part.toolCallId === event.toolCallId,
        );
        const pending = this.permission;
        this.permission = null;
        this.elicitation = null;

        if (!announced && pending?.toolCallId === event.toolCallId) {
          this.parts = [
            ...this.parts,
            {
              type: "tool-call",
              toolCallId: pending.toolCallId,
              toolName: pending.toolName,
              serverLabel: pending.serverLabel,
              arguments: pending.arguments,
              decision: event.decision ?? "approved",
            },
          ];
        }

        this.parts = [
          ...this.parts,
          {
            type: "tool-result",
            toolCallId: event.toolCallId,
            result: event.result,
            isError: event.isError,
          },
        ];
        break;
      }

      case "image-generated":
        this.parts = [
          ...this.parts,
          { type: "generated-image", imageId: event.imageId, prompt: event.prompt },
        ];
        break;

      case "error":
        this.notice = "error";
        break;

      case "done":
        this.#streaming = false;
        this.permission = null;
        this.elicitation = null;
        if (event.reason === "aborted") this.notice = "aborted";
        else if (event.reason === "interrupted") this.notice = "interrupted";
        else if (event.reason === "error") this.notice = "error";
        else if (event.reason === "unanswered") this.notice = "unanswered";
        // A per-turn cap stopped the turn at a clean boundary. The partial
        // answer stays on screen and the notice is friendly, never an error (§10).
        else if (event.reason === "budget") this.notice = "budget";
        break;

      default:
        break;
    }
  }

  /** Give up on the stream without claiming the turn ended. */
  detach(): void {
    this.#streaming = false;
    this.permission = null;
    this.elicitation = null;
  }

  clear(): void {
    this.parts = [];
    this.turnId = null;
    this.lastSeq = -1;
    this.notice = null;
    this.permission = null;
    this.elicitation = null;
    this.#streaming = false;
  }

  /**
   * Grow the trailing text part rather than adding one per delta.
   *
   * A message of ten thousand one-character parts renders the same and costs a
   * great deal more on the target hardware (§20).
   */
  #appendText(text: string): void {
    const last = this.parts.at(-1);

    if (last?.type === "text") {
      this.parts = [...this.parts.slice(0, -1), { type: "text", text: last.text + text }];
    } else {
      this.parts = [...this.parts, { type: "text", text }];
    }
  }
}
