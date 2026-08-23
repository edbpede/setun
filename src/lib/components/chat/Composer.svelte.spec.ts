import { describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-svelte";
import * as m from "$lib/paraglide/messages";
import { ComposerState } from "$lib/state/composer.svelte";
import Composer from "./Composer.svelte";

/**
 * Composer interaction (plan 1.8, PRD §10, §22).
 */

function setup(overrides: { streaming?: boolean } = {}) {
  const composer = new ComposerState();
  composer.attach(null);

  const onsend = vi.fn();
  const onabort = vi.fn();

  render(Composer, {
    composer,
    streaming: overrides.streaming ?? false,
    onsend,
    onabort,
  });

  return { composer, onsend, onabort };
}

describe("Composer", () => {
  it("disables sending until the draft has content", async () => {
    setup();

    const send = page.getByRole("button", { name: m.chat_send() });
    await expect.element(send).toBeDisabled();

    await page.getByRole("textbox").fill("Forklar loops");

    await expect.element(send).toBeEnabled();
  });

  it("sends on submit and clears the draft", async () => {
    const { composer, onsend } = setup();

    await page.getByRole("textbox").fill("Forklar loops");
    await page.getByRole("button", { name: m.chat_send() }).click();

    expect(onsend).toHaveBeenCalledTimes(1);
    // The parent takes the draft; the composer must not keep a copy behind.
    expect(composer.take().text).toBe("Forklar loops");
  });

  it("does not send a draft that is only whitespace", async () => {
    const { onsend } = setup();

    await page.getByRole("textbox").fill("   ");

    await expect.element(page.getByRole("button", { name: m.chat_send() })).toBeDisabled();
    expect(onsend).not.toHaveBeenCalled();
  });

  it("sends on Enter but not on Shift+Enter", async () => {
    const { onsend } = setup();

    const textbox = page.getByRole("textbox");
    await textbox.fill("Forklar loops");

    await textbox
      .element()
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true }));
    expect(onsend).not.toHaveBeenCalled();

    await textbox
      .element()
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(onsend).toHaveBeenCalledTimes(1);
  });

  it("does not send while an IME is composing", async () => {
    const { onsend } = setup();

    const textbox = page.getByRole("textbox");
    await textbox.fill("så");

    // A dead-key accent on a Danish keyboard fires Enter mid-composition.
    // `isComposing` is getter-only, so it has to come from the constructor.
    await textbox
      .element()
      .dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, isComposing: true }),
      );

    expect(onsend).not.toHaveBeenCalled();
  });

  it("offers stop instead of send while a turn streams", async () => {
    const { onabort } = setup({ streaming: true });

    await expect.element(page.getByRole("button", { name: m.chat_send() })).not.toBeInTheDocument();

    await page.getByRole("button", { name: m.chat_stop() }).click();

    expect(onabort).toHaveBeenCalledTimes(1);
  });

  it("shows an editing notice that can be cancelled", async () => {
    const { composer } = setup();

    composer.beginEdit("message-1", "første forsøg");

    await expect.element(page.getByText(m.chat_editing_notice())).toBeVisible();
    await expect.element(page.getByRole("textbox")).toHaveValue("første forsøg");

    await page.getByRole("button", { name: m.chat_cancel_edit() }).click();

    await expect.element(page.getByText(m.chat_editing_notice())).not.toBeInTheDocument();
    expect(composer.isEditing).toBe(false);
  });
});
