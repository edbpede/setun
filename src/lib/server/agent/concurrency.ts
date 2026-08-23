import type { AppDatabase } from "../db/client";
import { findActiveTurn } from "../db/queries/turns";
import type { Turn } from "../db/schema";

/**
 * One turn in flight per student (PRD §10).
 *
 * "One turn is in flight per student, across all of their conversations. Sending
 * a new message while a turn streams requires aborting it; the server enforces
 * this, not just the composer."
 *
 * So this is checked on the server for every send, and the check is against the
 * database rather than the in-process registry: after a restart the registry is
 * empty while the database still holds the row, and the guard must not be
 * fooled by that.
 */

export class TurnInFlightError extends Error {
  readonly activeTurnId: string;

  constructor(activeTurnId: string) {
    super("a turn is already in flight for this student");
    this.name = "TurnInFlightError";
    this.activeTurnId = activeTurnId;
  }
}

/** The student's in-flight turn across every conversation, or undefined. */
export function getActiveTurn(db: AppDatabase, studentId: string): Turn | undefined {
  return findActiveTurn(db, studentId);
}

/**
 * Refuse a new turn while one is streaming.
 *
 * The identifier travels with the error so the caller can tell the client which
 * turn to abort — the composer's "stop and resend" needs a target.
 */
export function assertNoTurnInFlight(db: AppDatabase, studentId: string): void {
  const active = getActiveTurn(db, studentId);
  if (active) throw new TurnInFlightError(active.id);
}
