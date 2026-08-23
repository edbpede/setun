import type { AppDatabase } from "../db/client";
import { appendTurnEvent, listTurnEvents } from "../db/queries/turns";
import type { GatewayEvent } from "../gateway/events";

/**
 * Turn event buffering (PRD §10).
 *
 * "The server buffers every event to the database as it streams… a reloaded or
 * discarded tab calls a resume endpoint that replays the buffered events and
 * tails the live turn — one code path for live and resumed turns."
 *
 * Persisting first and publishing second is what makes that one code path
 * possible: by the time a live subscriber sees an event it is already durable,
 * so a resuming client that reads the table and then subscribes can never
 * observe a gap between the two.
 */

export interface BufferedEvent {
  readonly seq: number;
  readonly event: GatewayEvent;
}

/**
 * Sequence numbers are dense and per-turn, assigned by the single writer of a
 * turn. `-1` is the "seen nothing" cursor, so the first event is `0`.
 */
export const NO_EVENTS_SEEN = -1;

export class TurnBuffer {
  readonly #db: AppDatabase;
  readonly #turnId: string;
  #nextSeq: number;

  constructor(db: AppDatabase, turnId: string, startAtSeq = 0) {
    this.#db = db;
    this.#turnId = turnId;
    this.#nextSeq = startAtSeq;
  }

  get turnId(): string {
    return this.#turnId;
  }

  /** Persist an event and return it with the sequence number it was given. */
  append(event: GatewayEvent): BufferedEvent {
    const seq = this.#nextSeq++;
    appendTurnEvent(this.#db, { turnId: this.#turnId, seq, payload: event });
    return { seq, event };
  }
}

/** Replay buffered events after a cursor — the first half of a resume (§10). */
export function readBufferedEvents(
  db: AppDatabase,
  input: { turnId: string; afterSeq?: number },
): BufferedEvent[] {
  return listTurnEvents(db, {
    turnId: input.turnId,
    afterSeq: input.afterSeq ?? NO_EVENTS_SEEN,
  }).map((row) => ({ seq: row.seq, event: row.payload as GatewayEvent }));
}
