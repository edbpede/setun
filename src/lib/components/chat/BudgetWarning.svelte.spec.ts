import { describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-svelte";
import * as m from "$lib/paraglide/messages";
import type { BudgetWarning as Warning } from "$lib/state/streaming-turn.svelte";
import BudgetWarning from "./BudgetWarning.svelte";

/**
 * The 70 % banner (PRD §10, §20, §22).
 *
 * It appears while the answer is still arriving — a response in flight is never
 * cut for it — so it has to offer a real choice while it can, and read as a
 * plain fact once the turn is over.
 */

const WARNING: Warning = {
  requestId: "daily-warning",
  fraction: 0.72,
  usedTokens: 72_000,
  limitTokens: 100_000,
  acknowledged: false,
};

describe("BudgetWarning", () => {
  it("shows the percentage and the figures behind it", async () => {
    render(BudgetWarning, {
      warning: WARNING,
      streaming: true,
      onkeepgoing: () => {},
      onstop: () => {},
    });

    await expect
      .element(page.getByText(m.chat_budget_warning_title({ percent: 72 })))
      .toBeVisible();
    await expect
      .element(page.getByText(m.allowance_used({ used: 72_000, limit: 100_000 })))
      .toBeVisible();
  });

  it("offers both choices while the answer is still arriving", async () => {
    const onkeepgoing = vi.fn();
    const onstop = vi.fn();
    render(BudgetWarning, { warning: WARNING, streaming: true, onkeepgoing, onstop });

    await page.getByRole("button", { name: m.chat_budget_warning_keep_going() }).click();
    expect(onkeepgoing).toHaveBeenCalledOnce();

    await page.getByRole("button", { name: m.chat_stop() }).click();
    expect(onstop).toHaveBeenCalledOnce();
  });

  it("drops the buttons once the pupil has said to keep going", async () => {
    render(BudgetWarning, {
      warning: { ...WARNING, acknowledged: true },
      streaming: true,
      onkeepgoing: () => {},
      onstop: () => {},
    });

    await expect
      .element(page.getByRole("button", { name: m.chat_budget_warning_keep_going() }))
      .not.toBeInTheDocument();
    await expect
      .element(page.getByText(m.chat_budget_warning_title({ percent: 72 })))
      .toBeVisible();
  });

  it("drops the buttons once the turn has ended — there is nothing left to stop", async () => {
    render(BudgetWarning, {
      warning: WARNING,
      streaming: false,
      onkeepgoing: () => {},
      onstop: () => {},
    });

    await expect.element(page.getByRole("button", { name: m.chat_stop() })).not.toBeInTheDocument();
    await expect
      .element(page.getByText(m.chat_budget_warning_title({ percent: 72 })))
      .toBeVisible();
  });
});
