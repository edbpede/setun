import type { GatewayEvent } from "./events";

/**
 * The single internal interface both dialects implement (PRD §9).
 *
 * Everything above the adapter depends on this type and on `GatewayEvent` —
 * never on a provider's own request or response shape.
 */

/** A message as the loop assembles it, before any dialect-specific encoding. */
export interface GatewayMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

export interface ChatRequest {
  /** The concrete gateway model identifier from the alias. Never sent to the browser (§9, §21). */
  readonly model: string;
  readonly messages: readonly GatewayMessage[];
  /** Aborting a turn cancels the upstream request (§10). */
  readonly signal?: AbortSignal;
  readonly maxOutputTokens?: number;
}

/** One entry of the gateway's model listing, used for educator-panel health (§9). */
export interface GatewayModel {
  readonly id: string;
}

export interface GatewayDialectAdapter {
  readonly name: "openai" | "anthropic";
  /** Streams normalised events. Always terminates with exactly one `done`. */
  streamChat(request: ChatRequest): AsyncGenerator<GatewayEvent>;
  listModels(signal?: AbortSignal): Promise<GatewayModel[]>;
}
