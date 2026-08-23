import { AnthropicDialect } from "./anthropic/dialect";
import { GatewayClient, type GatewayClientOptions } from "./client";
import type { ChatRequest, GatewayDialectAdapter, GatewayModel } from "./dialect";
import { GatewayError } from "./errors";
import type { GatewayEvent } from "./events";
import { OpenAiDialect } from "./openai/dialect";

/**
 * The gateway adapter (PRD §9).
 *
 * The only module that knows a dialect exists. Callers pass the alias's dialect
 * name and consume normalised events; no provider-specific logic lives above
 * this file (§3, §9).
 */

export type DialectName = GatewayDialectAdapter["name"];

export class GatewayAdapter {
  readonly #dialects: Record<DialectName, GatewayDialectAdapter>;

  constructor(options: GatewayClientOptions) {
    const client = new GatewayClient(options);
    this.#dialects = {
      openai: new OpenAiDialect(client),
      anthropic: new AnthropicDialect(client),
    };
  }

  /**
   * Stream a completion in the alias's dialect.
   *
   * Terminal events are the caller's concern: this yields text deltas and a
   * usage event, and the agent loop appends the `done` that ends the turn — it
   * is the loop, not the adapter, that knows why a turn stopped (§10).
   */
  streamChat(dialect: DialectName, request: ChatRequest): AsyncGenerator<GatewayEvent> {
    return this.#dialectFor(dialect).streamChat(request);
  }

  listModels(dialect: DialectName, signal?: AbortSignal): Promise<GatewayModel[]> {
    return this.#dialectFor(dialect).listModels(signal);
  }

  #dialectFor(dialect: DialectName): GatewayDialectAdapter {
    const implementation = this.#dialects[dialect];
    if (!implementation) {
      throw new GatewayError("rejected", `unknown dialect ${dialect}`);
    }
    return implementation;
  }
}
