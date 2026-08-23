import { describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-svelte";
import * as m from "$lib/paraglide/messages";
import StackCheckPanel from "./StackCheckPanel.svelte";

describe("StackCheckPanel", () => {
  it("keeps the dialog closed until the trigger is activated", async () => {
    render(StackCheckPanel);

    await expect.element(page.getByText(m.stack_check_dialog_title())).not.toBeInTheDocument();

    await page.getByTestId("dialog-trigger").click();

    await expect.element(page.getByText(m.stack_check_dialog_title())).toBeVisible();
    await expect.element(page.getByText(m.stack_check_dialog_description())).toBeVisible();
  });

  it("closes the dialog again from the footer control", async () => {
    render(StackCheckPanel);

    await page.getByTestId("dialog-trigger").click();
    await expect.element(page.getByText(m.stack_check_dialog_title())).toBeVisible();

    // Addressed by test id, not accessible name: the dialog ships its own
    // close control whose label is also "Close".
    await page.getByTestId("dialog-close").click();

    await expect.element(page.getByText(m.stack_check_dialog_title())).not.toBeInTheDocument();
  });

  it("resolves every clean-slate colour token to a real colour", async () => {
    render(StackCheckPanel);

    // A colour utility whose CSS variable does not resolve degrades to transparent
    // rather than failing loudly. `bg-sidebar` and `bg-chart-*` are the two the
    // preset misnames upstream, and the alias shim in app.css is what keeps them
    // painted — this asserts the shim is present and correct.
    for (const id of ["swatch-primary", "swatch-sidebar", "swatch-chart-1"]) {
      const swatch = page.getByTestId(id).element();
      const background = getComputedStyle(swatch).backgroundColor;

      expect(background, `${id} background`).not.toBe("transparent");
      expect(background, `${id} background`).not.toBe("rgba(0, 0, 0, 0)");
    }
  });

  it("resolves the clean-slate radius scale from the --radius variable", async () => {
    render(StackCheckPanel);

    const lg = page.getByTestId("radius-lg").element();
    const md = page.getByTestId("radius-md").element();

    // `rounded-lg` is `var(--radius)`; `rounded-md` is 2px less. If preset-shadcn's
    // radius scale were left under the Wind3 `borderRadius` key, presetWind4 would
    // silently substitute its own defaults and these would not differ by 2px.
    const lgRadius = Number.parseFloat(getComputedStyle(lg).borderTopLeftRadius);
    const mdRadius = Number.parseFloat(getComputedStyle(md).borderTopLeftRadius);

    expect(lgRadius).toBeGreaterThan(0);
    expect(lgRadius - mdRadius).toBeCloseTo(2, 1);
  });
});
