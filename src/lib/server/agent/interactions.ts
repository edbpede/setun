/**
 * Turn interactions awaiting a student's answer (PRD §11).
 *
 * A permission request and an elicitation are the same problem: the loop is
 * running detached from any request, it has emitted a question into the turn's
 * event stream, and it must wait for an answer that arrives on a *different*
 * HTTP request. Nothing request-scoped can bridge that.
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

export type InteractionAnswer = PermissionAnswer | ElicitationAnswer;

interface Pending {
  readonly resolve: (answer: InteractionAnswer | null) => void;
}

export class TurnInteractionRegistry {
  readonly #pending = new Map<string, Pending>();

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

    return new Promise<InteractionAnswer | null>((resolve) => {
      const settle = (answer: InteractionAnswer | null) => {
        clearTimeout(timer);
        input.signal?.removeEventListener("abort", onAbort);
        this.#pending.delete(key);
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

  /**
   * Deliver an answer. Returns false when nothing was waiting — a late click, or
   * a turn belonging to a process that has since restarted.
   */
  answer(input: { turnId: string; requestId: string; answer: InteractionAnswer }): boolean {
    const key = keyOf(input.turnId, input.requestId);
    const pending = this.#pending.get(key);
    if (!pending) return false;

    pending.resolve(input.answer);
    return true;
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
