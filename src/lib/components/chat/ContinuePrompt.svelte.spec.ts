import { describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-svelte";
import * as m from "$lib/paraglide/messages";
import type { PendingContinue } from "$lib/state/streaming-turn.svelte";
import ContinuePrompt from "./ContinuePrompt.svelte";

/**
 * The checkpoint prompt (PRD §10, §20, §22).
 *
 * A per-turn cap used to end the turn silently here. It now asks, and the
 * sentence has to say which cap was reached, in the pupil's own terms.
 */

function promptOf(overrides: Partial<PendingContinue> = {}): PendingContinue {
  return {
    requestId: "continue-1",
    cause: "steps",
    steps: 20,
    tokens: 4_000,
    elapsedMs: 300_000,
    usedTokens: 40_000,
    limitTokens: 100_000,
    ...overrides,
  };
}

describe("ContinuePrompt", () => {
  it("asks, and says how much of the day has gone", async () => {
    render(ContinuePrompt, { prompt: promptOf(), onrespond: () => {} });

    await expect.element(page.getByText(m.chat_continue_title())).toBeVisible();
    await expect
      .element(page.getByText(m.allowance_used({ used: 40_000, limit: 100_000 })))
      .toBeVisible();
  });

  it("names the step cap", async () => {
    render(ContinuePrompt, { prompt: promptOf({ cause: "steps" }), onrespond: () => {} });

    await expect.element(page.getByText(m.chat_continue_cause_steps({ steps: 20 }))).toBeVisible();
  });

  it("names the wall clock, in whole seconds", async () => {
    render(ContinuePrompt, {
      prompt: promptOf({ cause: "wall-clock", elapsedMs: 300_400 }),
      onrespond: () => {},
    });

    await expect
      .element(page.getByText(m.chat_continue_cause_wall_clock({ seconds: 300 })))
      .toBeVisible();
  });

  it("names the token cap", async () => {
    render(ContinuePrompt, {
      prompt: promptOf({ cause: "tokens", tokens: 4_000 }),
      onrespond: () => {},
    });

    await expect
      .element(page.getByText(m.chat_continue_cause_tokens({ tokens: 4_000 })))
      .toBeVisible();
  });

  it("explains a checkpoint reached because the allowance is running low", async () => {
    render(ContinuePrompt, { prompt: promptOf({ cause: "daily-warning" }), onrespond: () => {} });

    await expect.element(page.getByText(m.chat_continue_cause_daily_warning())).toBeVisible();
  });

  it("answers yes and no", async () => {
    const onrespond = vi.fn();
    render(ContinuePrompt, { prompt: promptOf(), onrespond });

    await page.getByRole("button", { name: m.chat_continue_yes() }).click();
    expect(onrespond).toHaveBeenLastCalledWith(true);

    await page.getByRole("button", { name: m.chat_continue_stop() }).click();
    expect(onrespond).toHaveBeenLastCalledWith(false);
  });
});
