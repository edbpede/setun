import { AnthropicDialect } from "./anthropic/dialect";
import { GatewayClient, type GatewayClientOptions } from "./client";
import type {
  ChatRequest,
  GatewayDialectAdapter,
  GatewayModel,
  GeneratedImageBytes,
  ImageRequest,
} from "./dialect";
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

  /**
   * Generate one image, returning its bytes (§15).
   *
   * "Image generation runs through the gateway adapter and is subject to the
   * same classroom enablement, allowlist, permission, and budget rules as text."
   * The enablement lives above; what lives here is that a provider URL stops at
   * this boundary and only bytes travel on.
   */
  generateImage(dialect: DialectName, request: ImageRequest): Promise<GeneratedImageBytes> {
    return this.#dialectFor(dialect).generateImage(request);
  }

  #dialectFor(dialect: DialectName): GatewayDialectAdapter {
    const implementation = this.#dialects[dialect];
    if (!implementation) {
      throw new GatewayError("rejected", `unknown dialect ${dialect}`);
    }
    return implementation;
  }
}
