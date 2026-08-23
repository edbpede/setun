import { expect, test } from "@playwright/test";

test("serves the stack validation route and opens the dialog", async ({ page }) => {
  await page.goto("/stack-check");

  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

  await page.getByTestId("dialog-trigger").click();
  await expect(page.getByRole("dialog")).toBeVisible();
});
