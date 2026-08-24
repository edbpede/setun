import { parseSseStream } from "../../sse";
import { GatewayClient } from "../client";
import type {
  ChatRequest,
  GatewayContentPart,
  GatewayDialectAdapter,
  GatewayMessage,
  GatewayModel,
  GatewayToolDefinition,
  GeneratedImageBytes,
  ImageRequest,
} from "../dialect";
import { GatewayError } from "../errors";
import type { GatewayEvent } from "../events";
import { promptTextOf } from "../messages";
import { resolveUsage } from "../usage";

/**
 * The OpenAI-compatible dialect: `/v1/chat/completions`, `/v1/models`,
 * `/v1/images` (PRD §9). This is the default dialect.
 *
 * Nothing here escapes the module: the caller receives only normalised events.
 */

interface ToolCallDelta {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface ChatCompletionChunk {
  choices?: {
    delta?: { content?: string | null; tool_calls?: ToolCallDelta[] };
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
        messages: request.messages.map(encodeMessage),
        stream: true,
        // Without this the OpenAI dialect omits usage from streamed responses
        // entirely, and every turn would fall back to an estimate (§10).
        stream_options: { include_usage: true },
        ...(request.tools?.length ? { tools: request.tools.map(encodeTool) } : {}),
        ...(request.maxOutputTokens ? { max_tokens: request.maxOutputTokens } : {}),
      },
      { signal: request.signal, accept: "text/event-stream" },
    );

    let completion = "";
    let reported: { inputTokens?: number; outputTokens?: number } | undefined;
    /** Tool calls arrive in fragments across chunks, keyed by their index. */
    const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();

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

      const delta = chunk.choices?.[0]?.delta;

      if (delta?.content) {
        completion += delta.content;
        yield { type: "text-delta", text: delta.content };
      }

      for (const fragment of delta?.tool_calls ?? []) {
        const index = fragment.index ?? 0;
        const existing = toolCalls.get(index) ?? { id: "", name: "", arguments: "" };
        toolCalls.set(index, {
          id: fragment.id ?? existing.id,
          name: fragment.function?.name ?? existing.name,
          arguments: existing.arguments + (fragment.function?.arguments ?? ""),
        });
      }
    }

    // Emitted once complete: a half-assembled argument string is not a call the
    // loop could execute, and the student's permission prompt would name nothing.
    for (const call of toolCalls.values()) {
      if (!call.name) continue;
      yield {
        type: "tool-call-started",
        toolCallId: call.id || crypto.randomUUID(),
        toolName: call.name,
        arguments: call.arguments,
      };
    }

    yield resolveUsage({
      reported,
      promptText: promptTextOf(request.messages),
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

  /**
   * Generate one image and return its bytes (§15).
   *
   * `b64_json` is requested explicitly so the common case needs no second
   * request; a provider that answers with a URL anyway is fetched here, on the
   * server, so the URL still never reaches a browser.
   */
  async generateImage(request: ImageRequest): Promise<GeneratedImageBytes> {
    const response = await this.#client.post(
      "/v1/images/generations",
      { model: request.model, prompt: request.prompt, n: 1, response_format: "b64_json" },
      { signal: request.signal },
    );

    const payload = (await response.json()) as {
      data?: { b64_json?: string; url?: string }[];
    };
    const first = payload.data?.[0];

    if (first?.b64_json) {
      return { bytes: decodeBase64(first.b64_json), mediaType: "image/png" };
    }
    if (first?.url) {
      const fetched = await fetch(first.url, { signal: request.signal });
      if (!fetched.ok)
        throw new GatewayError("unavailable", `image fetch failed ${fetched.status}`);
      return {
        bytes: new Uint8Array(await fetched.arrayBuffer()),
        mediaType: fetched.headers.get("content-type") ?? "image/png",
      };
    }

    throw new GatewayError("unavailable", "image response carried no image");
  }
}

function encodeTool(tool: GatewayToolDefinition) {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  };
}

function encodeMessage(message: GatewayMessage) {
  if (message.role === "tool") {
    return {
      role: "tool",
      tool_call_id: message.toolCallId,
      content: typeof message.content === "string" ? message.content : "",
    };
  }

  if (message.role === "assistant" && message.toolCalls?.length) {
    return {
      role: "assistant",
      content: typeof message.content === "string" ? message.content : "",
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: call.arguments },
      })),
    };
  }

  return { role: message.role, content: encodeContent(message.content) };
}

function encodeContent(content: string | readonly GatewayContentPart[]) {
  if (typeof content === "string") return content;

  return content.map((part) =>
    part.type === "text"
      ? { type: "text", text: part.text }
      : // Inline data, never a URL the provider would fetch on our behalf (§21).
        { type: "image_url", image_url: { url: `data:${part.mediaType};base64,${part.data}` } },
  );
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
