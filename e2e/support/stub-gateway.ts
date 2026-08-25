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

/** A prompt containing this asks the stub to answer slowly. */
export const SLOW_MARKER = "LANGSOM-SVAR";

/**
 * A prompt containing this asks the stub to answer with an HTML artifact (§13).
 *
 * The artifact flow needs a model that emits a recognised fenced block, and the
 * marker travels in the prompt because that is the only part of the request a
 * test controls.
 */
export const ARTIFACT_MARKER = "ARTEFAKT-HTML";

/** What the stub writes when asked for one. Detection is on the fence tag alone (§13). */
export const ARTIFACT_REPLY = [
  "Her er siden:",
  "```html",
  "<!doctype html><html><head><title>Klikkeren</title></head>",
  "<body><button id=\"knap\">Klik her</button></body></html>",
  "```",
  "Prøv den.",
].join("\n");

/**
 * A prompt containing this asks the stub for a long answer, streamed flat out.
 *
 * The §20 frame budget is about plain text arriving faster than a dual-core
 * Celeron can lay it out, so the case worth measuring is many small deltas with
 * no delay between them.
 */
export const LONG_MARKER = "LANG-TEKST";

/** Long enough to stream for a while; ordinary prose, because that is the case §20 names. */
export const LONG_REPLY = Array.from(
  { length: 120 },
  (_, i) => `sætning ${i} om hvordan et neuralt netværk sender information videre.`,
).join(" ");

const SLOW_WORD_DELAY_MS = 400;

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

    // Drain the request body so the client's write completes — and read it, so
    // a test can ask for a slow answer.
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const payload = Buffer.concat(chunks).toString();

    /**
     * A deliberately slow answer, for the one case that needs a turn still in
     * flight while something else happens to it — a classroom locking mid-stream
     * (PRD §8). The marker travels in the prompt because that is the only part
     * of the request a test controls.
     */
    const slow = payload.includes(SLOW_MARKER);
    const perWordDelay = slow ? SLOW_WORD_DELAY_MS : options.delayMs;
    const body = payload.includes(ARTIFACT_MARKER)
      ? ARTIFACT_REPLY
      : payload.includes(LONG_MARKER)
        ? LONG_REPLY
        : reply;

    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    });

    // One word per chunk, so the test observes genuine incremental streaming.
    for (const word of body.split(" ")) {
      response.write(sseChunk({ choices: [{ delta: { content: `${word} ` } }] }));
      if (perWordDelay) await new Promise((r) => setTimeout(r, perWordDelay));
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
