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

/**
 * A prompt containing this asks the stub for a reply with reasoning (§20).
 *
 * Only the Responses transport carries reasoning at all, so this marker is also
 * what proves the application is speaking it.
 */
export const THINKING_MARKER = "TAENKNING";

/** The summary the stub streams before its answer, one delta per word. */
export const THINKING_REPLY = "Jeg overvejer opgaven og finder et svar.";

/**
 * A model that has no `/v1/responses` at all.
 *
 * The gateway answers 404 for it, which is the fallback the dialect memoises —
 * so a turn on this alias streams over chat completions and carries no thinking.
 */
export const LEGACY_MODEL = "stub-model-legacy";

/** A prompt containing this asks for an artifact written as several files (§13). */
export const ARTIFACT_PROJECT_MARKER = "ARTEFAKT-PROJEKT";

export const ARTIFACT_PROJECT_REPLY = [
  "Her er projektet:",
  '```html id=projektet path=index.html title="Projektet" entry',
  '<!doctype html><html><head><link rel="stylesheet" href="styles.css"></head>',
  '<body><p id="hilsen">Hej fra projektet</p></body></html>',
  "```",
  "```css id=projektet path=styles.css",
  "#hilsen { color: rgb(0, 128, 128) }",
  "```",
  "Prøv det.",
].join("\n");

/** And this asks for a revision of it that touches only the stylesheet. */
export const ARTIFACT_PROJECT_REVISION_MARKER = "ARTEFAKT-PROJEKT-FARVE";

export const ARTIFACT_PROJECT_REVISION_REPLY = [
  "Jeg har skiftet farven:",
  "```css id=projektet path=styles.css",
  "#hilsen { color: rgb(128, 0, 128) }",
  "```",
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

/** Which prepared reply a prompt asks for. Matched against the newest user message. */
function replyFor(ask: string, fallback: string): string {
  if (ask.includes(ARTIFACT_LONG_MARKER)) return ARTIFACT_LONG_REPLY;
  if (ask.includes(ARTIFACT_PROJECT_REVISION_MARKER)) return ARTIFACT_PROJECT_REVISION_REPLY;
  if (ask.includes(ARTIFACT_PROJECT_MARKER)) return ARTIFACT_PROJECT_REPLY;
  if (ask.includes(ARTIFACT_REVISION_MARKER)) return ARTIFACT_REVISION_REPLY;
  if (ask.includes(ARTIFACT_SECOND_MARKER)) return ARTIFACT_SECOND_REPLY;
  if (ask.includes(ARTIFACT_MARKER)) return ARTIFACT_REPLY;
  if (ask.includes(LONG_MARKER)) return LONG_REPLY;
  return fallback;
}

/**
 * The newest user message of a Responses request.
 *
 * A different shape from chat completions: the conversation is `input`, a user
 * message's prose sits in `input_text` parts, and a tool's answer is an item of
 * its own rather than a role.
 */
function lastResponsesInput(payload: string): string {
  try {
    const parsed = JSON.parse(payload) as {
      input?: { role?: string; content?: { type?: string; text?: string }[] }[];
    };
    const last = parsed.input?.findLast((item) => item.role === "user");
    if (!last) return payload;

    return (last.content ?? [])
      .map((part) => (part.type === "input_text" ? (part.text ?? "") : ""))
      .join(" ");
  } catch {
    return payload;
  }
}

/** The model a Responses request names, so the legacy alias can be refused. */
function requestedModel(payload: string): string {
  try {
    return String((JSON.parse(payload) as { model?: unknown }).model ?? "");
  } catch {
    return "";
  }
}

/** One Responses SSE record, framed as the upstream frames it. */
function responseEvent(type: string, payload: Record<string, unknown> = {}): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
}

export async function startStubGateway(
  options: { reply?: string; delayMs?: number; port?: number } = {},
): Promise<StubGateway> {
  const reply = options.reply ?? "Et loop gentager en handling.";

  const server: Server = createServer(async (request, response) => {
    if (request.url?.startsWith("/v1/models")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "stub-model" }, { id: LEGACY_MODEL }] }));
      return;
    }

    /**
     * The transport the application prefers, and the only one that carries the
     * model's reasoning (§20).
     *
     * `LEGACY_MODEL` answers 404 here, which is the fallback the dialect
     * memoises: a turn on that alias arrives at chat completions below and
     * streams with no thinking at all.
     */
    if (request.url?.startsWith("/v1/responses")) {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const payload = Buffer.concat(chunks).toString();

      if (requestedModel(payload) === LEGACY_MODEL) {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "unknown url: /v1/responses" } }));
        return;
      }

      const ask = lastResponsesInput(payload);
      const body = replyFor(ask, reply);
      const slow = ask.includes(SLOW_MARKER);
      const perWordDelay = slow ? SLOW_WORD_DELAY_MS : options.delayMs;

      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      response.write(responseEvent("response.created"));

      // Reasoning first, as a real one does: the summary is what the pupil sees
      // in the collapsed block before a word of the answer arrives.
      if (ask.includes(THINKING_MARKER)) {
        response.write(responseEvent("response.reasoning_summary_part.added", { summary_index: 0 }));
        for (const word of THINKING_REPLY.split(" ")) {
          response.write(
            responseEvent("response.reasoning_summary_text.delta", { delta: `${word} ` }),
          );
        }
      }

      for (const word of body.split(" ")) {
        response.write(responseEvent("response.output_text.delta", { delta: `${word} ` }));
        if (perWordDelay) await new Promise((r) => setTimeout(r, perWordDelay));
      }

      response.write(
        responseEvent("response.completed", {
          response: { status: "completed", usage: { input_tokens: 18, output_tokens: 6 } },
        }),
      );
      response.end();
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
    const body = replyFor(ask, reply);

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
