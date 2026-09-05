import { describe, expect, it } from "bun:test";
import { TurnInteractionRegistry } from "./interactions";

/**
 * The registry that bridges a detached loop and the request carrying an answer
 * (PRD §11, §10).
 *
 * The awkward case is the checkpoint: the 70 % warning is emitted while the
 * answer is still streaming, and the pupil may press "Keep going" minutes before
 * the boundary that asks. That click has to count.
 */

const TURN = "turn-1";

describe("answering a question the loop is waiting on", () => {
  it("resolves the waiter", async () => {
    const registry = new TurnInteractionRegistry();
    const pending = registry.wait({ turnId: TURN, requestId: "call-1", timeoutMs: 1_000 });

    expect(registry.size).toBe(1);
    expect(
      registry.answer({
        turnId: TURN,
        requestId: "call-1",
        answer: { kind: "permission", approved: true },
      }),
    ).toBe(true);

    expect(await pending).toEqual({ kind: "permission", approved: true });
    expect(registry.size).toBe(0);
  });

  it("resolves to null when nobody answers in time", async () => {
    const registry = new TurnInteractionRegistry();

    expect(await registry.wait({ turnId: TURN, requestId: "call-1", timeoutMs: 1 })).toBeNull();
  });

  it("resolves to null when the turn is aborted", async () => {
    const registry = new TurnInteractionRegistry();
    const controller = new AbortController();
    const pending = registry.wait({
      turnId: TURN,
      requestId: "call-1",
      timeoutMs: 10_000,
      signal: controller.signal,
    });

    controller.abort();
    expect(await pending).toBeNull();
  });

  it("drops an answer to a question nobody asked", () => {
    const registry = new TurnInteractionRegistry();

    expect(
      registry.answer({
        turnId: TURN,
        requestId: "stale",
        answer: { kind: "permission", approved: true },
      }),
    ).toBe(false);
  });
});

describe("an answer that arrives before the loop waits for it (§10)", () => {
  it("preserves the first answer and rejects retries before and after consumption", async () => {
    const registry = new TurnInteractionRegistry();
    const question = { turnId: TURN, requestId: "daily-warning" };
    registry.expect(question);
    expect(registry.answer({ ...question, answer: { kind: "continue", proceed: false } })).toBe(
      true,
    );
    expect(registry.answer({ ...question, answer: { kind: "continue", proceed: true } })).toBe(
      false,
    );
    expect(await registry.wait({ ...question, timeoutMs: 1 })).toEqual({
      kind: "continue",
      proceed: false,
    });
    expect(registry.answer({ ...question, answer: { kind: "continue", proceed: true } })).toBe(
      false,
    );
  });
  it("is held for a declared question and consumed by the wait", async () => {
    const registry = new TurnInteractionRegistry();
    registry.expect({ turnId: TURN, requestId: "daily-warning" });

    expect(
      registry.answer({
        turnId: TURN,
        requestId: "daily-warning",
        answer: { kind: "continue", proceed: true },
      }),
    ).toBe(true);
    // Nothing is waiting; the answer is held rather than resolved.
    expect(registry.size).toBe(0);

    const answer = await registry.wait({
      turnId: TURN,
      requestId: "daily-warning",
      timeoutMs: 1,
    });

    expect(answer).toEqual({ kind: "continue", proceed: true });
  });

  it("can be taken without waiting, and only once", () => {
    const registry = new TurnInteractionRegistry();
    registry.expect({ turnId: TURN, requestId: "daily-warning" });
    registry.answer({
      turnId: TURN,
      requestId: "daily-warning",
      answer: { kind: "continue", proceed: false },
    });

    expect(registry.takeEarly({ turnId: TURN, requestId: "daily-warning" })).toEqual({
      kind: "continue",
      proceed: false,
    });
    expect(registry.takeEarly({ turnId: TURN, requestId: "daily-warning" })).toBeNull();
  });

  /**
   * Only declared questions may be answered early. Buffering anything else would
   * let a stale tab answer a question that no longer exists.
   */
  it("is not held for a question the loop never declared", () => {
    const registry = new TurnInteractionRegistry();

    expect(
      registry.answer({
        turnId: TURN,
        requestId: "continue-1",
        answer: { kind: "continue", proceed: true },
      }),
    ).toBe(false);
    expect(registry.takeEarly({ turnId: TURN, requestId: "continue-1" })).toBeNull();
  });

  it("is scoped to its own turn", () => {
    const registry = new TurnInteractionRegistry();
    registry.expect({ turnId: TURN, requestId: "daily-warning" });
    registry.answer({
      turnId: TURN,
      requestId: "daily-warning",
      answer: { kind: "continue", proceed: true },
    });

    expect(registry.takeEarly({ turnId: "turn-2", requestId: "daily-warning" })).toBeNull();
  });

  it("dies with the turn that declared it", () => {
    const registry = new TurnInteractionRegistry();
    registry.expect({ turnId: TURN, requestId: "daily-warning" });
    registry.answer({
      turnId: TURN,
      requestId: "daily-warning",
      answer: { kind: "continue", proceed: true },
    });

    registry.release(TURN);

    expect(registry.takeEarly({ turnId: TURN, requestId: "daily-warning" })).toBeNull();
    expect(
      registry.answer({
        turnId: TURN,
        requestId: "daily-warning",
        answer: { kind: "continue", proceed: true },
      }),
    ).toBe(false);
  });
});
