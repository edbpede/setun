/**
 * Turn interactions awaiting a student's answer (PRD §11).
 *
 * A permission request, an elicitation and a checkpoint's "shall I keep going?"
 * are the same problem: the loop is running detached from any request, it has
 * emitted a question into the turn's event stream, and it must wait for an
 * answer that arrives on a *different* HTTP request. Nothing request-scoped can
 * bridge that.
 *
 * On the rule against module-scope state in server modules: this is the same
 * category as the live-turn registry — process infrastructure holding resolvers
 * for in-flight work, keyed by turn and request identifier, and reachable only
 * after the responding request has proved it owns the turn (§21). Nothing here
 * is derived from a request, and an entry's lifetime is one question's.
 */

export interface PermissionAnswer {
  readonly kind: "permission";
  readonly approved: boolean;
}

export interface ElicitationAnswer {
  readonly kind: "elicitation";
  /** Only the flat primitives §11 allows; the loop validated them on arrival. */
  readonly values: Readonly<Record<string, string | number | boolean>>;
  /** A student may decline to answer, which cancels the call rather than retrying it. */
  readonly declined: boolean;
}

/**
 * "Keep going" or "stop here", at a checkpoint (§10).
 *
 * The one answer that can arrive *before* the loop waits for it: the 70 %
 * warning is emitted mid-stream and the pupil may press "Keep going" while the
 * answer is still arriving, minutes before the boundary that asks.
 */
export interface ContinueAnswer {
  readonly kind: "continue";
  readonly proceed: boolean;
}

export type InteractionAnswer = PermissionAnswer | ElicitationAnswer | ContinueAnswer;

interface Pending {
  readonly resolve: (answer: InteractionAnswer | null) => void;
}

export class TurnInteractionRegistry {
  readonly #pending = new Map<string, Pending>();
  /**
   * Answers that arrived before anything waited for them.
   *
   * Only for questions the loop has declared with `expect`. Without this an
   * early "Keep going" would be dropped as a late click, and the pupil would be
   * asked again at the boundary they have already answered for.
   */
  readonly #early = new Map<string, InteractionAnswer>();
  /** Which questions this turn may receive an early answer to. */
  readonly #expected = new Map<string, Set<string>>();

  /**
   * Declare a question whose answer may arrive before the loop waits for it.
   *
   * Nothing else may be answered early: an unexpected identifier is still a late
   * click, and buffering those would let a stale tab answer a question that no
   * longer exists.
   */
  expect(input: { turnId: string; requestId: string }): void {
    const keys = this.#expected.get(input.turnId) ?? new Set<string>();
    keys.add(input.requestId);
    this.#expected.set(input.turnId, keys);
  }

  /**
   * Wait for an answer to one question.
   *
   * Resolves to null when nobody answered in time or the turn was aborted — the
   * loop then continues without the tool rather than hanging, because a student
   * who closed the tab must not leave a turn running until its wall-clock cap.
   */
  wait(input: {
    turnId: string;
    requestId: string;
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<InteractionAnswer | null> {
    const key = keyOf(input.turnId, input.requestId);

    // Already answered, before this wait began. Consumed rather than waited on.
    const early = this.takeEarly(input);
    if (early) return Promise.resolve(early);

    return new Promise<InteractionAnswer | null>((resolve) => {
      const settle = (answer: InteractionAnswer | null) => {
        clearTimeout(timer);
        input.signal?.removeEventListener("abort", onAbort);
        this.#pending.delete(key);
        this.#expected.get(input.turnId)?.delete(input.requestId);
        resolve(answer);
      };

      const timer = setTimeout(() => settle(null), input.timeoutMs);
      const onAbort = () => settle(null);

      if (input.signal?.aborted) {
        settle(null);
        return;
      }
      input.signal?.addEventListener("abort", onAbort, { once: true });

      this.#pending.set(key, { resolve: settle });
    });
  }

  /** Take an early answer if one arrived, without waiting for one that has not. */
  takeEarly(input: { turnId: string; requestId: string }): InteractionAnswer | null {
    const key = keyOf(input.turnId, input.requestId);
    const answer = this.#early.get(key);
    if (!answer) return null;

    this.#early.delete(key);
    this.#expected.get(input.turnId)?.delete(input.requestId);
    return answer;
  }

  /**
   * Deliver an answer. Returns false when nothing was waiting — a late click, or
   * a turn belonging to a process that has since restarted.
   *
   * An answer to a declared-but-not-yet-awaited question is held instead, so the
   * pupil's click counts even though the loop had not reached the boundary.
   */
  answer(input: { turnId: string; requestId: string; answer: InteractionAnswer }): boolean {
    const key = keyOf(input.turnId, input.requestId);
    const pending = this.#pending.get(key);

    if (!pending) {
      if (!this.#expected.get(input.turnId)?.has(input.requestId)) return false;
      if (this.#early.has(key)) return false;
      this.#early.set(key, input.answer);
      return true;
    }

    pending.resolve(input.answer);
    return true;
  }

  /** Forget everything a finished turn declared, so nothing outlives it. */
  release(turnId: string): void {
    for (const requestId of this.#expected.get(turnId) ?? []) {
      this.#early.delete(keyOf(turnId, requestId));
    }
    this.#expected.delete(turnId);
  }

  get size(): number {
    return this.#pending.size;
  }
}

function keyOf(turnId: string, requestId: string): string {
  return `${turnId}:${requestId}`;
}

/** The process-wide registry. One question is answered by one request. */
export const turnInteractions = new TurnInteractionRegistry();
