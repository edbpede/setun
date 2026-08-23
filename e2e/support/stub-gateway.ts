import { createServer, type Server } from "node:http";

/**
 * A stand-in for CPA in end-to-end tests.
 *
 * The PRD's exit criterion asks for verification against a running CPA, which
 * needs real provider credentials — not something CI can hold. This speaks the
 * OpenAI-compatible dialect over the same HTTP and SSE surface the adapter
 * targets, so everything from the route down is exercised for real; only the
 * provider behind it is substituted.
 */

export interface StubGateway {
  readonly url: string;
  close(): Promise<void>;
}

function sseChunk(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

export async function startStubGateway(
  options: { reply?: string; delayMs?: number; port?: number } = {},
): Promise<StubGateway> {
  const reply = options.reply ?? "Et loop gentager en handling.";

  const server: Server = createServer(async (request, response) => {
    if (request.url?.startsWith("/v1/models")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "stub-model" }] }));
      return;
    }

    if (!request.url?.startsWith("/v1/chat/completions")) {
      response.writeHead(404).end();
      return;
    }

    // Drain the request body so the client's write completes.
    for await (const _ of request) {
      // ignored
    }

    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    });

    // One word per chunk, so the test observes genuine incremental streaming.
    for (const word of reply.split(" ")) {
      response.write(sseChunk({ choices: [{ delta: { content: `${word} ` } }] }));
      if (options.delayMs) await new Promise((r) => setTimeout(r, options.delayMs));
    }

    response.write(
      sseChunk({ choices: [], usage: { prompt_tokens: 18, completion_tokens: 6 } }),
    );
    response.write("data: [DONE]\n\n");
    response.end();
  });

  await new Promise<void>((resolve) => server.listen(options.port ?? 0, "127.0.0.1", resolve));

  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("stub gateway did not bind a port");
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
