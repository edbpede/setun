import { error } from "@sveltejs/kit";
import * as v from "valibot";
import { sseResponse } from "$lib/server/agent/sse-response";
import { streamTurnEvents } from "$lib/server/agent/stream";
import { NO_EVENTS_SEEN } from "$lib/server/agent/turn-buffer";
import { requireStudentApi } from "$lib/server/auth/guards";
import { getDb } from "$lib/server/boot";
import { getOwnedTurn } from "$lib/server/db/queries/turns";
import type { RequestHandler } from "./$types";

/**
 * Resume a turn (PRD §10).
 *
 * "A reloaded or discarded tab calls a resume endpoint that replays the buffered
 * events and tails the live turn — one code path for live and resumed turns."
 *
 * That code path is `streamTurnEvents`, the same function the send endpoint
 * returns. The only difference is the cursor.
 */

const CursorSchema = v.optional(
  v.pipe(v.string(), v.transform(Number), v.number(), v.integer(), v.minValue(NO_EVENTS_SEEN)),
);

export const GET: RequestHandler = ({ params, url, locals }) => {
  const student = requireStudentApi(locals);
  const db = getDb();

  // Owner-scoped: another student's turn is absent, not forbidden (§21).
  const turn = getOwnedTurn(db, { turnId: params.turnId, studentId: student.id });
  if (!turn) error(404, "Not found");

  const cursor = v.safeParse(CursorSchema, url.searchParams.get("after") ?? undefined);
  if (!cursor.success) error(400, "Invalid cursor");

  return sseResponse(streamTurnEvents(db, turn.id, { afterSeq: cursor.output ?? NO_EVENTS_SEEN }));
};
