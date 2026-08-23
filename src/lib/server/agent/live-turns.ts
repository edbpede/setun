import type { BufferedEvent } from "./turn-buffer";

/**
 * The registry of turns currently streaming in this process (PRD §10).
 *
 * Resume "replays the buffered events and tails the live turn", and aborting
 * "cancels the in-flight upstream request" — both need a handle on work already
 * running, which no request-scoped value can provide.
 *
 * On the rule against module-scope state in server modules: that rule is about
 * *request or user* state leaking between requests. This is neither. It is
 * process infrastructure — the same category as a connection pool — holding
 * abort handles and subscriber lists for in-flight work, keyed by turn id and
 * reachable only after the caller has proved ownership of that turn (§21).
 * Nothing here is derived from the current request, and an entry's lifetime is
 * the turn's, not a request's.
 *
 * State that does belong to a request stays on `event.locals`, as it does.
 */

type Listener = (event: BufferedEvent) => void;

interface LiveTurn {
  readonly abortController: AbortController;
  readonly listeners: Set<Listener>;
  /** Set when the producer finishes; a late subscriber then reads the buffer only. */
  ended: boolean;
}

export class LiveTurnRegistry {
  readonly #turns = new Map<string, LiveTurn>();

  /**
   * Announce a turn as live, returning the signal its producer must pass
   * upstream so that aborting the turn cancels the gateway request (§10).
   */
  register(turnId: string): AbortSignal {
    const abortController = new AbortController();
    this.#turns.set(turnId, { abortController, listeners: new Set(), ended: false });
    return abortController.signal;
  }

  /** Fan a persisted event out to tailing subscribers. Called after it is durable. */
  publish(event: { turnId: string; buffered: BufferedEvent }): void {
    const live = this.#turns.get(event.turnId);
    if (!live) return;

    for (const listener of live.listeners) listener(event.buffered);
  }

  /** Mark the turn finished and release it; subscribers are woken to close. */
  end(turnId: string): void {
    const live = this.#turns.get(turnId);
    if (!live) return;

    live.ended = true;
    // Wake every tail so it re-checks and completes rather than hanging.
    for (const listener of live.listeners)
      listener({ seq: -1, event: { type: "done", reason: "stop" } });
    this.#turns.delete(turnId);
  }

  /**
   * Cancel a running turn. Returns false when nothing was running — a turn that
   * already finished, or one owned by another process after a restart.
   */
  abort(turnId: string): boolean {
    const live = this.#turns.get(turnId);
    if (!live) return false;

    live.abortController.abort();
    return true;
  }

  isLive(turnId: string): boolean {
    return this.#turns.has(turnId);
  }

  /**
   * Subscribe to a live turn's events.
   *
   * Returns null when the turn is not live in this process, which the caller
   * treats as "everything there is to see is already in the buffer".
   */
  subscribe(turnId: string, listener: Listener): (() => void) | null {
    const live = this.#turns.get(turnId);
    if (!live || live.ended) return null;

    live.listeners.add(listener);
    return () => live.listeners.delete(listener);
  }
}

/**
 * The process-wide registry.
 *
 * A single instance per server process is the point: a turn is produced by one
 * process and tailed by requests arriving at that same process.
 */
export const liveTurns = new LiveTurnRegistry();
