import { requireStudentApi } from "$lib/server/auth/guards";
import { getDb } from "$lib/server/boot";
import { watchClassroomStatus } from "$lib/server/classroom/state-channel";
import type { ClassroomStatus } from "$lib/server/classroom/status";
import type { RequestHandler } from "./$types";

/**
 * The classroom-state channel (PRD §6, §8).
 *
 * SSE, like every stream in Setun — there are no WebSockets (§5). A GET with no
 * body, so the browser's own `EventSource` reads it and reconnects on its own.
 *
 * Thin by §6.1: authorise, delegate to `$lib/server/classroom`, frame the
 * response. This channel is a convenience and never an authorisation path — a
 * tab that never connects is refused by the same guard as one that did (§8, §21).
 */

/** Sent between updates so an idle connection is not mistaken for a dead one. */
const HEARTBEAT_MS = 25_000;

export const GET: RequestHandler = ({ locals, request }) => {
  const student = requireStudentApi(locals);
  const db = getDb();

  const encoder = new TextEncoder();
  const abort = new AbortController();
  // The tab went away, or the server is shutting down.
  request.signal.addEventListener("abort", () => abort.abort(), { once: true });

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const heartbeat = setInterval(() => {
        // A comment frame: valid SSE, ignored by every client, keeps
        // intermediaries from closing an idle connection.
        try {
          controller.enqueue(encoder.encode(": keep-alive\n\n"));
        } catch {
          abort.abort();
        }
      }, HEARTBEAT_MS);

      try {
        for await (const status of watchClassroomStatus(db, student, {
          signal: abort.signal,
        })) {
          controller.enqueue(encoder.encode(frame(status)));
        }
      } catch {
        // A broken transport is not something to report to a pupil; the page
        // keeps working and the next request is authorised on its own merits.
      } finally {
        clearInterval(heartbeat);
        controller.close();
      }
    },
    cancel() {
      abort.abort();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // Caddy is a plain proxy (§5); this keeps any intermediary from buffering.
      "x-accel-buffering": "no",
    },
  });
};

function frame(status: ClassroomStatus): string {
  return `event: status\ndata: ${JSON.stringify(status)}\n\n`;
}
