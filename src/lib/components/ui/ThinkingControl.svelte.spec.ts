import { describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-svelte";
import * as m from "$lib/paraglide/messages";
import { THINKING_STORAGE_KEY } from "$lib/state/thinking.svelte";
import ThinkingControlHost from "./ThinkingControlHost.test.svelte";

/**
 * The pupil's own switch (PRD §16, §20, §22).
 *
 * A device setting: it is stored in this browser and reaches neither the server
 * nor another pupil's Chromebook.
 */

describe("ThinkingControl", () => {
  it("starts on, because a pupil who has chosen nothing sees the reasoning", async () => {
    localStorage.removeItem(THINKING_STORAGE_KEY);
    render(ThinkingControlHost);

    await expect
      .element(page.getByRole("switch", { name: m.chat_thinking_toggle_label() }))
      .toHaveAttribute("aria-checked", "true");
  });

  it("turns the block off and remembers it in this browser", async () => {
    localStorage.removeItem(THINKING_STORAGE_KEY);
    render(ThinkingControlHost);

    const control = page.getByRole("switch", { name: m.chat_thinking_toggle_label() });
    await control.click();

    await expect.element(control).toHaveAttribute("aria-checked", "false");
    expect(localStorage.getItem(THINKING_STORAGE_KEY)).toBe("hide");

    // Back on is stored as the absence of a choice rather than as a second value.
    await control.click();
    expect(localStorage.getItem(THINKING_STORAGE_KEY)).toBeNull();
  });
});
