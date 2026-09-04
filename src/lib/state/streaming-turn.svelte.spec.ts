import { describe, expect, it } from "vitest";
import { StreamingTurn } from "./streaming-turn.svelte";

/**
 * Folding checkpoint events into the in-flight turn (PRD §10, §22).
 *
 * The banner and the prompt have different lifetimes on purpose: the prompt is
 * a question about this turn and dies with it, the banner is a fact about the
 * pupil's day and outlives the streaming message it appeared beside.
 */

describe("StreamingTurn — the 70 % banner", () => {
  it("records the figures the pupil is shown", () => {
    const turn = new StreamingTurn();
    turn.begin("turn-1");

    turn.apply(
      {
        type: "budget-warning",
        requestId: "daily-warning",
        fraction: 0.72,
        usedTokens: 72_000,
        limitTokens: 100_000,
      },
      0,
    );

    expect(turn.budgetWarning).toEqual({
      requestId: "daily-warning",
      fraction: 0.72,
      usedTokens: 72_000,
      limitTokens: 100_000,
      acknowledged: false,
    });
  });

  it("survives the streaming message being replaced by the persisted one", () => {
    const turn = new StreamingTurn();
    turn.begin("turn-1");
    turn.apply(
      {
        type: "budget-warning",
        requestId: "daily-warning",
        fraction: 0.9,
        usedTokens: 90,
        limitTokens: 100,
      },
      0,
    );

    turn.clear();

    expect(turn.budgetWarning).not.toBeNull();
    expect(turn.parts).toEqual([]);
  });

  it("starts clean on the next turn", () => {
    const turn = new StreamingTurn();
    turn.begin("turn-1");
    turn.apply(
      {
        type: "budget-warning",
        requestId: "daily-warning",
        fraction: 0.9,
        usedTokens: 90,
        limitTokens: 100,
      },
      0,
    );

    turn.begin("turn-2");

    expect(turn.budgetWarning).toBeNull();
  });

  it("remembers that the pupil answered it", () => {
    const turn = new StreamingTurn();
    turn.begin("turn-1");
    turn.apply(
      {
        type: "budget-warning",
        requestId: "daily-warning",
        fraction: 0.9,
        usedTokens: 90,
        limitTokens: 100,
      },
      0,
    );

    turn.acknowledgeWarning();

    expect(turn.budgetWarning?.acknowledged).toBe(true);
  });
});

describe("StreamingTurn — the checkpoint prompt", () => {
  const request = {
    type: "continue-request",
    requestId: "continue-1",
    cause: "steps",
    caps: ["steps"],
    turn: { steps: 20, tokens: 4_000, elapsedMs: 120_000 },
    daily: { usedTokens: 40_000, limitTokens: 100_000 },
  } as const;

  it("flattens the request into what the prompt renders", () => {
    const turn = new StreamingTurn();
    turn.begin("turn-1");

    turn.apply(request, 0);

    expect(turn.continuePrompt).toEqual({
      requestId: "continue-1",
      cause: "steps",
      steps: 20,
      tokens: 4_000,
      elapsedMs: 120_000,
      usedTokens: 40_000,
      limitTokens: 100_000,
    });
    expect(turn.waiting).toBe(true);
  });

  it("clears the moment the loop moves on", () => {
    const turn = new StreamingTurn();
    turn.begin("turn-1");
    turn.apply(request, 0);

    turn.apply({ type: "text-delta", text: "videre" }, 1);

    expect(turn.continuePrompt).toBeNull();
    expect(turn.waiting).toBe(false);
  });

  it("clears when the turn ends", () => {
    const turn = new StreamingTurn();
    turn.begin("turn-1");
    turn.apply(request, 0);

    turn.apply({ type: "done", reason: "budget" }, 1);

    expect(turn.continuePrompt).toBeNull();
    expect(turn.notice).toBe("budget");
  });

  it("clears when the tab gives up on the stream", () => {
    const turn = new StreamingTurn();
    turn.begin("turn-1");
    turn.apply(request, 0);

    turn.detach();

    expect(turn.continuePrompt).toBeNull();
  });

  it("names a daily ceiling that ran out mid-turn", () => {
    const turn = new StreamingTurn();
    turn.begin("turn-1");

    turn.apply({ type: "done", reason: "student-allowance-exhausted" }, 0);

    expect(turn.notice).toBe("student-allowance-exhausted");
  });
});
