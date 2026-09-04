import type { PerTurnCap } from "../agent/budgets";

/**
 * The normalised internal event stream (PRD §9, §10).
 *
 * This is the wire format everything above the gateway adapter consumes, and the
 * reason nothing above it knows which dialect answered. Providers change; this
 * does not.
 *
 * The full set is defined now even though the zero-tool loop of M1 emits only
 * `text-delta`, `usage`, `error` and `done`: the tool events are what Phase 3
 * fills in, and defining them here keeps the transport, the buffer and the
 * client from being rewritten when it does.
 */

/** Why a turn ended. Every terminated turn carries exactly one of these (§10). */
export type TurnEndReason =
  | "stop"
  /** The student was asked something and did not answer within the turn's time (§11). */
  | "unanswered"
  | "aborted"
  | "error"
  /** A checkpoint asked whether to continue and nobody answered in time (§10). */
  | "budget"
  /** The provider stopped at its own output ceiling; the answer is cut short (§10). */
  | "truncated"
  /** A daily ceiling ran out mid-turn. These are the hard limits (§10). */
  | "student-allowance-exhausted"
  | "classroom-cap-exhausted"
  /** The server restarted mid-turn; resume shows a cut-short notice (§10). */
  | "interrupted";

export interface TextDeltaEvent {
  readonly type: "text-delta";
  readonly text: string;
}

export interface ToolCallStartedEvent {
  readonly type: "tool-call-started";
  readonly toolCallId: string;
  readonly toolName: string;
  /** The server this tool came from, for the attribution the student is shown (§11). */
  readonly serverLabel?: string | null;
  readonly arguments?: unknown;
}

export interface PermissionRequestEvent {
  readonly type: "permission-request";
  readonly toolCallId: string;
  readonly toolName: string;
  readonly serverLabel?: string | null;
  readonly sensitive: boolean;
  /** What the call would do, so the student is approving something specific (§11). */
  readonly arguments?: unknown;
}

/**
 * One field of an interim request for input (§11).
 *
 * "A restricted set of input types (free text, number, boolean, single-choice
 * selection — the flat elicitation primitives; nothing richer)." The MCP
 * transport produces a structurally identical type of its own; the conversion
 * in the loop is the compile-time check that the two have not drifted.
 */
export interface ElicitationFieldSpec {
  readonly name: string;
  readonly label: string;
  readonly type: "text" | "number" | "boolean" | "choice";
  readonly required: boolean;
  readonly options?: readonly string[];
}

/**
 * A tool asking the student a question before it can finish (§11).
 *
 * Rendered "with server attribution and a restricted set of input types", and
 * the original request is retried once the answers are in.
 */
export interface ElicitationRequestEvent {
  readonly type: "elicitation-request";
  readonly toolCallId: string;
  readonly toolName: string;
  readonly serverLabel?: string | null;
  readonly message: string;
  readonly fields: readonly ElicitationFieldSpec[];
}

export interface ToolResultEvent {
  readonly type: "tool-result";
  readonly toolCallId: string;
  /** Tool output is untrusted input, never a privileged instruction (§11, §21). */
  readonly result: unknown;
  readonly isError: boolean;
  /**
   * Why this result is a refusal rather than a tool's answer (§11, §19).
   *
   * Absent on a result the tool produced. Present when the permission mode
   * stopped the call — which is the "permission decisions" §19 asks a message
   * to record, arriving on the event that stands in for the call's outcome.
   */
  readonly decision?: "declined" | "unanswered";
}

/**
 * An image the generation path produced and stored (§15).
 *
 * Carries the identifier of a locally stored image, never a provider URL: the
 * browser fetches it from Setun, scoped to its owner (§15, §21).
 */
export interface ImageGeneratedEvent {
  readonly type: "image-generated";
  readonly imageId: string;
  readonly prompt: string;
}

/**
 * Why the provider stopped generating (§10).
 *
 * Normalised from `finish_reason` / `stop_reason` / an incomplete Responses
 * status. Without it a provider that hit its own output ceiling looks exactly
 * like a model that finished its sentence, and the pupil is shown a truncated
 * answer with nothing to say so.
 */
export type FinishReason = "stop" | "length" | "tool-calls";

export interface UsageEventPayload {
  readonly type: "usage";
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** True when Setun estimated the figures; usage is never counted as zero (§10). */
  readonly estimated: boolean;
  /** Absent when the provider never said — an abort, or a stream cut short. */
  readonly finishReason?: FinishReason;
}

/**
 * The day's allowance is 70 % spent, while the answer is still streaming (§10).
 *
 * Emitted once per turn. A response in flight is never cut for this: the pupil
 * sees the figure at once and can stop, and the confirmation to carry on is
 * collected at the next clean boundary instead.
 */
export interface BudgetWarningEvent {
  readonly type: "budget-warning";
  readonly requestId: string;
  readonly fraction: number;
  readonly usedTokens: number;
  readonly limitTokens: number;
}

/** What brought the turn to a checkpoint. */
export type ContinueCause = PerTurnCap | "daily-warning";

/**
 * "Shall I keep going?" at a clean boundary (§10).
 *
 * Every result is durable and the next model call has not been made, so the
 * pupil is deciding about work that has not started rather than interrupting
 * work in flight.
 */
export interface ContinueRequestEvent {
  readonly type: "continue-request";
  readonly requestId: string;
  readonly cause: ContinueCause;
  readonly caps: readonly PerTurnCap[];
  readonly turn: {
    readonly steps: number;
    readonly tokens: number;
    readonly elapsedMs: number;
  };
  readonly daily: {
    readonly usedTokens: number;
    readonly limitTokens: number;
  };
}

/**
 * A failure the student can be told about.
 *
 * The message is already student-facing and already safe: the adapter maps every
 * upstream failure to one unavailability message, so no upstream URL, provider
 * identifier, OAuth error, token or stack trace can travel in it (§9, §21).
 */
export interface ErrorEvent {
  readonly type: "error";
  readonly message: string;
}

export interface DoneEvent {
  readonly type: "done";
  readonly reason: TurnEndReason;
}

export type GatewayEvent =
  | TextDeltaEvent
  | ToolCallStartedEvent
  | PermissionRequestEvent
  | ElicitationRequestEvent
  | ToolResultEvent
  | ImageGeneratedEvent
  | BudgetWarningEvent
  | ContinueRequestEvent
  | UsageEventPayload
  | ErrorEvent
  | DoneEvent;

export type GatewayEventType = GatewayEvent["type"];

/** Narrowing helper for the buffer and the transport, which handle events generically. */
export function isTerminalEvent(event: GatewayEvent): event is DoneEvent {
  return event.type === "done";
}
