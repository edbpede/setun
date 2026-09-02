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
  '```html id=klikkeren title="Klikkeren"',
  "<!doctype html><html><head><title>Klikkeren</title></head>",
  '<body><button id="knap">Klik her</button></body></html>',
  "```",
  "Prøv den.",
].join("\n");

/**
 * A prompt containing this asks for a *revision* of the same artifact (§13).
 *
 * The whole point of the id on the fence: a second turn under the same id is a
 * new revision of one thing rather than a second thing, and the reply is a
 * complete document rather than the fragment that used to replace the page.
 */
export const ARTIFACT_REVISION_MARKER = "ARTEFAKT-QUIZ";

export const ARTIFACT_REVISION_REPLY = [
  "Jeg har tilføjet quizzen:",
  '```html id=klikkeren title="Klikkeren"',
  "<!doctype html><html><head><title>Klikkeren</title></head>",
  '<body><button id="knap">Klik her</button>',
  '<section id="quiz"><p>Hvad hedder jeg?</p></section>',
  "</body></html>",
  "```",
  "Prøv den nu.",
].join("\n");

/** A prompt containing this asks for a second, separate artifact under a new id. */
export const ARTIFACT_SECOND_MARKER = "ARTEFAKT-LOGO";

export const ARTIFACT_SECOND_REPLY = [
  "Her er logoet:",
  '```svg id=logo title="Logo"',
  '<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="teal"/></svg>',
  "```",
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

/**
 * A prompt containing this asks the stub for a long answer that is an artifact.
 *
 * `LONG_MARKER` never streams a fence, so it cannot see a regression in the
 * boundary scan the streaming transcript now does per delta (§13, §20).
 */
export const ARTIFACT_LONG_MARKER = "ARTEFAKT-LANG-SIDE";

/** The same shape a model writes: prose, a long complete file, prose. */
export const ARTIFACT_LONG_REPLY = [
  "Her er siden:",
  '```html id=lang-side title="Den lange side"',
  "<!doctype html>",
  "<html>",
  "<body>",
  ...Array.from({ length: 150 }, (_, i) => `<p class="linje">Afsnit ${i} på den lange side.</p>`),
  "</body>",
  "</html>",
  "```",
  "Færdig med den lange side.",
].join("\n");

const SLOW_WORD_DELAY_MS = 400;

/**
 * The text of the newest user message, or the whole body if it cannot be read.
 *
 * Falling back to the whole payload rather than to nothing: a malformed request
 * is a stub bug, and a test that silently gets the default reply is harder to
 * diagnose than one that behaves as it did before.
 */
function lastUserContent(payload: string): string {
  try {
    const parsed = JSON.parse(payload) as {
      messages?: { role?: string; content?: unknown }[];
    };
    const last = parsed.messages?.findLast((message) => message.role === "user");
    if (!last) return payload;

    if (typeof last.content === "string") return last.content;
    if (Array.isArray(last.content)) {
      return last.content
        .map((part: unknown) =>
          typeof part === "object" && part !== null && "text" in part
            ? String((part as { text: unknown }).text)
            : "",
        )
        .join(" ");
    }
    return payload;
  } catch {
    return payload;
  }
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

    // Drain the request body so the client's write completes — and read it, so
    // a test can ask for a slow answer.
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const payload = Buffer.concat(chunks).toString();

    /**
     * Markers are matched against the *last user message* only.
     *
     * The whole payload now carries the conversation, and an artifact turn puts
     * its own reply back into it as context — so scanning everything made turn
     * two replay turn one's answer forever. This is the only part of the request
     * a test controls, and it is the part that just arrived.
     */
    const ask = lastUserContent(payload);

    /**
     * A deliberately slow answer, for the one case that needs a turn still in
     * flight while something else happens to it — a classroom locking mid-stream
     * (PRD §8). The marker travels in the prompt because that is the only part
     * of the request a test controls.
     */
    const slow = ask.includes(SLOW_MARKER);
    const perWordDelay = slow ? SLOW_WORD_DELAY_MS : options.delayMs;
    const body = ask.includes(ARTIFACT_LONG_MARKER)
      ? ARTIFACT_LONG_REPLY
      : ask.includes(ARTIFACT_REVISION_MARKER)
      ? ARTIFACT_REVISION_REPLY
      : ask.includes(ARTIFACT_SECOND_MARKER)
        ? ARTIFACT_SECOND_REPLY
        : ask.includes(ARTIFACT_MARKER)
          ? ARTIFACT_REPLY
          : ask.includes(LONG_MARKER)
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
