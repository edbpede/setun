import { error, json } from "@sveltejs/kit";
import { liveTurns } from "$lib/server/agent/live-turns";
import { requireStudentApi } from "$lib/server/auth/guards";
import { getDb } from "$lib/server/boot";
import { finishTurn, getOwnedTurn, isTerminal } from "$lib/server/db/queries/turns";
import type { RequestHandler } from "./$types";

/**
 * Abort a turn (PRD §10).
 *
 * "Aborting a turn cancels the in-flight upstream request and any running tool
 * execution."
 *
 * Cancelling the registry's controller propagates the abort to the gateway
 * request; the runner then persists the terminal event and marks the row, so a
 * tab tailing the stream sees the turn end rather than the connection drop.
 */
export const POST: RequestHandler = ({ params, locals }) => {
  const student = requireStudentApi(locals);
  const db = getDb();

  const turn = getOwnedTurn(db, { turnId: params.turnId, studentId: student.id });
  if (!turn) error(404, "Not found");

  // Already finished: aborting is idempotent, not an error.
  if (isTerminal(turn.status)) return json({ aborted: false, status: turn.status });

  const cancelled = liveTurns.abort(turn.id);

  if (!cancelled) {
    // Marked streaming but produced by a process that no longer exists — the
    // boot sweep would catch it, but a student asking now deserves an answer.
    finishTurn(db, { turnId: turn.id, status: "interrupted" });
    return json({ aborted: true, status: "interrupted" });
  }

  return json({ aborted: true, status: "aborted" });
};
