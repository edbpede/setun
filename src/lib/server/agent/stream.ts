import type { AppDatabase } from "../db/client";
import { getTurn, isTerminal } from "../db/queries/turns";
import type { GatewayEvent } from "../gateway/events";
import { liveTurns } from "./live-turns";
import { type BufferedEvent, NO_EVENTS_SEEN, readBufferedEvents } from "./turn-buffer";

/**
 * Reading a turn's event stream (PRD §10).
 *
 * "A reloaded or discarded tab calls a resume endpoint that replays the buffered
 * events and tails the live turn — one code path for live and resumed turns."
 *
 * This is that code path. The POST that starts a turn calls it with no cursor;
 * a resume calls it with the last sequence number the client saw. Neither is a
 * special case of the other.
 */

export interface StreamTurnOptions {
  /** Last sequence number the client already has. Omit to replay from the start. */
  readonly afterSeq?: number;
}

/**
 * Yield a turn's events from `afterSeq` onward, tailing while it is live.
 *
 * Ordering is guaranteed by subscribing *before* reading the buffer: an event
 * that lands between the two arrives on the subscription and is de-duplicated by
 * sequence number, so no event can slip through the gap in either direction.
 */
export async function* streamTurnEvents(
  db: AppDatabase,
  turnId: string,
  options: StreamTurnOptions = {},
): AsyncGenerator<BufferedEvent> {
  const afterSeq = options.afterSeq ?? NO_EVENTS_SEEN;

  const pending: BufferedEvent[] = [];
  let notify: (() => void) | null = null;
  let ended = false;

  const unsubscribe = liveTurns.subscribe(turnId, (buffered) => {
    // The registry wakes tails with a sentinel when a turn ends.
    if (buffered.seq === NO_EVENTS_SEEN) ended = true;
    else pending.push(buffered);
    notify?.();
  });

  try {
    let lastSeq = afterSeq;

    for (const buffered of readBufferedEvents(db, { turnId, afterSeq })) {
      lastSeq = buffered.seq;
      yield buffered;
      if (isDone(buffered.event)) return;
    }

    // Not live here: either it finished before we subscribed, or it belongs to
    // a previous process. Either way the buffer held everything there was.
    if (!unsubscribe) {
      yield* trailingInterruption(db, turnId, lastSeq);
      return;
    }

    while (true) {
      while (pending.length > 0) {
        const buffered = pending.shift();
        if (!buffered) break;
        // Anything at or below the cursor was already replayed from the buffer.
        if (buffered.seq <= lastSeq) continue;

        lastSeq = buffered.seq;
        yield buffered;
        if (isDone(buffered.event)) return;
      }

      if (ended) {
        // The producer stopped without a terminal event reaching us — replay
        // whatever it persisted last, then close.
        for (const buffered of readBufferedEvents(db, { turnId, afterSeq: lastSeq })) {
          lastSeq = buffered.seq;
          yield buffered;
          if (isDone(buffered.event)) return;
        }
        yield* trailingInterruption(db, turnId, lastSeq);
        return;
      }

      await new Promise<void>((resolve) => {
        notify = () => {
          notify = null;
          resolve();
        };
      });
    }
  } finally {
    unsubscribe?.();
  }
}

/**
 * Close out a turn whose stream ended without a terminal event.
 *
 * The case this exists for: the server restarted mid-turn, boot marked the row
 * interrupted, and a tab resumes afterwards. It must be told the response was
 * cut short rather than waiting on a producer that no longer exists (§10).
 */
function* trailingInterruption(
  db: AppDatabase,
  turnId: string,
  lastSeq: number,
): Generator<BufferedEvent> {
  const turn = getTurn(db, turnId);
  if (!turn || !isTerminal(turn.status)) return;

  const reason = turn.status === "aborted" ? "aborted" : "interrupted";
  yield { seq: lastSeq + 1, event: { type: "done", reason } };
}

function isDone(event: GatewayEvent): boolean {
  return event.type === "done";
}
