import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-svelte";
import { EDUCATOR_RECOVERY_COMMAND } from "$lib/educator-recovery";
import * as m from "$lib/paraglide/messages";
import EducatorRecoveryPanel from "./EducatorRecoveryPanel.svelte";

afterEach(() => vi.restoreAllMocks());

describe("EducatorRecoveryPanel", () => {
  it("reveals only the generic operator command", async () => {
    render(EducatorRecoveryPanel);

    await page.getByText(m.educator_recovery_action()).click();

    await expect.element(page.getByText(m.educator_recovery_title())).toBeVisible();
    await expect.element(page.getByText(EDUCATOR_RECOVERY_COMMAND)).toBeVisible();
  });

  it("copies the command and announces success accessibly", async () => {
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    render(EducatorRecoveryPanel);

    await page.getByText(m.educator_recovery_action()).click();
    await page.getByRole("button", { name: m.educator_recovery_copy() }).click();

    expect(writeText).toHaveBeenCalledWith(EDUCATOR_RECOVERY_COMMAND);
    await expect.element(page.getByRole("status")).toHaveTextContent(m.educator_recovery_copied());
  });

  it("announces a clipboard failure without hiding the selectable command", async () => {
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("clipboard refused"));
    render(EducatorRecoveryPanel);

    await page.getByText(m.educator_recovery_action()).click();
    await page.getByRole("button", { name: m.educator_recovery_copy() }).click();

    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent(m.educator_recovery_copy_failed());
    await expect.element(page.getByText(EDUCATOR_RECOVERY_COMMAND)).toBeVisible();
  });
});
