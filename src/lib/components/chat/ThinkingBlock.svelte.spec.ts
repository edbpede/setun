import { describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-svelte";
import * as m from "$lib/paraglide/messages";
import ThinkingBlock from "./ThinkingBlock.svelte";

/**
 * The reasoning block (PRD §20, §21, §22).
 *
 * Collapsed by default, plain text throughout, and honest about whether the
 * model is still working.
 */

const SUMMARY = "**Læser opgaven**\n\nDerefter skriver jeg en liste.";

describe("ThinkingBlock", () => {
  it("is collapsed by default — the answer is what the pupil asked for", async () => {
    render(ThinkingBlock, { text: SUMMARY });

    await expect.element(page.getByText(m.chat_thoughts())).toBeVisible();
    await expect.element(page.getByText("Derefter skriver jeg en liste.")).not.toBeVisible();
  });

  it("opens to the paragraphs of the summary", async () => {
    render(ThinkingBlock, { text: SUMMARY });

    await page.getByText(m.chat_thoughts()).click();

    await expect.element(page.getByText("Derefter skriver jeg en liste.")).toBeVisible();
  });

  /**
   * The model wrote this, and a model's output is untrusted: the block renders
   * text nodes and nothing else (§21).
   */
  it("renders markup as text, never as HTML", async () => {
    render(ThinkingBlock, { text: "Måske <img src=x onerror=alert(1)>" });

    await page.getByText(m.chat_thoughts()).click();

    await expect.element(page.getByText("Måske <img src=x onerror=alert(1)>")).toBeVisible();
    expect(document.querySelector("img")).toBeNull();
  });

  it("counts seconds and shows the latest headline while it is live", async () => {
    let clock = 10_000;
    render(ThinkingBlock, {
      text: SUMMARY,
      live: true,
      startedAt: 1_000,
      now: () => clock,
    });

    await expect.element(page.getByText(m.chat_thinking_elapsed({ seconds: 9 }))).toBeVisible();
    // The headline is the latest paragraph's first line, with the provider's
    // markdown emphasis stripped rather than rendered as asterisks.
    expect(document.querySelector("summary")?.textContent).toContain(
      "Derefter skriver jeg en liste.",
    );
  });

  it("settles to the time it took once the answer starts arriving", async () => {
    render(ThinkingBlock, {
      text: SUMMARY,
      live: false,
      startedAt: 1_000,
      settledAt: 13_000,
      now: () => 90_000,
    });

    await expect.element(page.getByText(m.chat_thoughts_elapsed({ seconds: 12 }))).toBeVisible();
    await expect
      .element(page.getByText(m.chat_thinking_elapsed({ seconds: 12 })))
      .not.toBeInTheDocument();
  });
});
