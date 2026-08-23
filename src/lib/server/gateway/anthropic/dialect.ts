import { GatewayClient } from "../client";
import type { ChatRequest, GatewayDialectAdapter, GatewayModel } from "../dialect";
import { GatewayError } from "../errors";
import type { GatewayEvent } from "../events";
import { parseSseStream } from "../sse";
import { resolveUsage } from "../usage";

/**
 * The Anthropic-native Messages dialect (PRD §9).
 *
 * Two shape differences from the OpenAI dialect matter and are absorbed here:
 * the system prompt is a top-level field rather than a message with a role, and
 * usage arrives split across `message_start` (input) and `message_delta`
 * (output) rather than in one trailing chunk.
 */

interface MessageStreamEvent {
  type?: string;
  delta?: { text?: string; stop_reason?: string | null };
  content_block?: { type?: string; text?: string };
  message?: { usage?: { input_tokens?: number; output_tokens?: number } };
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { message?: string };
}

/** Anthropic requires an explicit output ceiling; CPA forwards it unchanged. */
const DEFAULT_MAX_TOKENS = 4096;

export class AnthropicDialect implements GatewayDialectAdapter {
  readonly name = "anthropic" as const;
  readonly #client: GatewayClient;

  constructor(client: GatewayClient) {
    this.#client = client;
  }

  async *streamChat(request: ChatRequest): AsyncGenerator<GatewayEvent> {
    // System messages are a top-level parameter in this dialect, not a role.
    const system = request.messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n\n");
    const conversation = request.messages.filter((m) => m.role !== "system");

    const response = await this.#client.post(
      "/v1/messages",
      {
        model: request.model,
        max_tokens: request.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
        stream: true,
        ...(system ? { system } : {}),
        messages: conversation.map((m) => ({
          role: m.role,
          content: [{ type: "text", text: m.content }],
        })),
      },
      { signal: request.signal, accept: "text/event-stream" },
    );

    let completion = "";
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;

    for await (const event of parseSseStream(GatewayClient.requireBody(response))) {
      let payload: MessageStreamEvent;
      try {
        payload = JSON.parse(event.data) as MessageStreamEvent;
      } catch {
        throw new GatewayError("unavailable", "malformed chunk in upstream stream");
      }

      const type = payload.type ?? event.event;

      switch (type) {
        case "message_start": {
          inputTokens = payload.message?.usage?.input_tokens ?? inputTokens;
          outputTokens = payload.message?.usage?.output_tokens ?? outputTokens;
          break;
        }
        case "content_block_delta": {
          const text = payload.delta?.text;
          if (text) {
            completion += text;
            yield { type: "text-delta", text };
          }
          break;
        }
        case "content_block_start": {
          // A block can open with text already in it.
          const text = payload.content_block?.text;
          if (text) {
            completion += text;
            yield { type: "text-delta", text };
          }
          break;
        }
        case "message_delta": {
          outputTokens = payload.usage?.output_tokens ?? outputTokens;
          break;
        }
        case "error": {
          throw new GatewayError("unavailable", payload.error?.message ?? "upstream stream error");
        }
        default:
          break;
      }
    }

    yield resolveUsage({
      reported: { inputTokens, outputTokens },
      promptText: request.messages.map((m) => m.content).join("\n"),
      completionText: completion,
    });
  }

  async listModels(signal?: AbortSignal): Promise<GatewayModel[]> {
    const response = await this.#client.get("/v1/models", { signal });
    const payload = (await response.json()) as { data?: { id?: string }[] };

    return (payload.data ?? [])
      .filter((entry): entry is { id: string } => typeof entry.id === "string")
      .map((entry) => ({ id: entry.id }));
  }
}
