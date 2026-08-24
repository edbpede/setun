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
  /** A per-turn cap ended it at a clean boundary; partial content is preserved (§10, Phase 2.7). */
  | "budget"
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

export interface UsageEventPayload {
  readonly type: "usage";
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** True when Setun estimated the figures; usage is never counted as zero (§10). */
  readonly estimated: boolean;
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
  | UsageEventPayload
  | ErrorEvent
  | DoneEvent;

export type GatewayEventType = GatewayEvent["type"];

/** Narrowing helper for the buffer and the transport, which handle events generically. */
export function isTerminalEvent(event: GatewayEvent): event is DoneEvent {
  return event.type === "done";
}
