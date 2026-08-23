import { GatewayClient } from "../client";
import type { ChatRequest, GatewayDialectAdapter, GatewayModel } from "../dialect";
import { GatewayError } from "../errors";
import type { GatewayEvent } from "../events";
import { parseSseStream } from "../sse";
import { resolveUsage } from "../usage";

/**
 * The OpenAI-compatible dialect: `/v1/chat/completions`, `/v1/models`,
 * `/v1/images` (PRD §9). This is the default dialect.
 *
 * Nothing here escapes the module: the caller receives only normalised events.
 */

interface ChatCompletionChunk {
  choices?: {
    delta?: { content?: string | null };
    finish_reason?: string | null;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
}

const DONE_SENTINEL = "[DONE]";

export class OpenAiDialect implements GatewayDialectAdapter {
  readonly name = "openai" as const;
  readonly #client: GatewayClient;

  constructor(client: GatewayClient) {
    this.#client = client;
  }

  async *streamChat(request: ChatRequest): AsyncGenerator<GatewayEvent> {
    const response = await this.#client.post(
      "/v1/chat/completions",
      {
        model: request.model,
        messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
        stream: true,
        // Without this the OpenAI dialect omits usage from streamed responses
        // entirely, and every turn would fall back to an estimate (§10).
        stream_options: { include_usage: true },
        ...(request.maxOutputTokens ? { max_tokens: request.maxOutputTokens } : {}),
      },
      { signal: request.signal, accept: "text/event-stream" },
    );

    let completion = "";
    let reported: { inputTokens?: number; outputTokens?: number } | undefined;

    for await (const event of parseSseStream(GatewayClient.requireBody(response))) {
      if (event.data === DONE_SENTINEL) break;

      let chunk: ChatCompletionChunk;
      try {
        chunk = JSON.parse(event.data) as ChatCompletionChunk;
      } catch {
        // A malformed chunk is an upstream fault, not something to pass through.
        throw new GatewayError("unavailable", "malformed chunk in upstream stream");
      }

      if (chunk.usage) {
        reported = {
          inputTokens: chunk.usage.prompt_tokens,
          outputTokens: chunk.usage.completion_tokens,
        };
      }

      const text = chunk.choices?.[0]?.delta?.content;
      if (text) {
        completion += text;
        yield { type: "text-delta", text };
      }
    }

    yield resolveUsage({
      reported,
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
