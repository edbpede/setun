import { expect, type Page, test } from "@playwright/test";
import * as m from "../src/lib/paraglide/messages";
import { E2E_EDUCATOR_PASSWORD, E2E_EDUCATOR_USERNAME } from "../playwright.config";
import { clearLoginWindow } from "./support/login-window";

/**
 * The alias editor's save loop (PRD §9, §17, §21, §22).
 *
 * Three defects met here in one sitting, all of which look identical from the
 * educator's chair — the panel and the database disagreeing with no way to tell:
 *
 * - A successful save emptied the row's name and gateway identifier on screen
 *   while the database kept the real values. SvelteKit's default `enhance`
 *   resets the form on success, and a reset restores each control to its `value`
 *   *attribute*, which Svelte never writes.
 * - With those two fields blanked, `required` blocked every subsequent save in
 *   the browser: no message, no request, nothing to distinguish it from a save
 *   that worked.
 * - A genuinely rejected save reported valibot's own words, "Invalid type:
 *   Expected number but received NaN" (§21).
 *
 * Playwright rather than a component spec because the mechanism is the browser's
 * own form reset and constraint validation, which is precisely what a mounted
 * component test does not have.
 */

test.beforeEach(clearLoginWindow);

async function signIn(page: Page): Promise<void> {
  await page.goto("/educator/login");
  await page.getByLabel(m.educator_username_label()).fill(E2E_EDUCATOR_USERNAME);
  await page.getByLabel(m.educator_password_label()).fill(E2E_EDUCATOR_PASSWORD);
  await page.getByRole("button", { name: m.educator_login_submit() }).click();
  await expect(page).toHaveURL(/\/educator$/);
}

test("an alias survives a save, and a rejected save says why", async ({ page }) => {
  await signIn(page);
  await page.goto("/educator/models");

  const rows = page.locator("ul > li");
  const rowsBefore = await rows.count();

  // This suite's own alias, so it never edits one another suite is using.
  const name = `E2E alias ${Date.now()}`;
  const create = page.locator('form[action="?/create"]');
  await create.locator('input[name="name"]').fill(name);
  await create.locator('input[name="gatewayModelId"]').fill("e2e-alias-model");
  await create.getByRole("button", { name: m.educator_add_alias() }).click();

  /**
   * Rows are addressed by which one holds this name, resolved once.
   *
   * Not by an `input[value=…]` selector: that matches the value *attribute*, and
   * the absence of that attribute is the very defect under test.
   */
  await expect(rows).toHaveCount(rowsBefore + 1);

  const index = await rows
    .locator('input[name="name"]')
    .evaluateAll((inputs, wanted) => inputs.findIndex((i) => (i as HTMLInputElement).value === wanted), name);
  expect(index).toBeGreaterThanOrEqual(0);

  const row = rows.nth(index);

  // A save that works leaves the row showing what was saved.
  await row.getByRole("button", { name: m.educator_save() }).click();
  await expect(row.locator('input[name="name"]')).toHaveValue(name);
  await expect(row.locator('input[name="gatewayModelId"]')).toHaveValue("e2e-alias-model");

  // …and the row is still saveable afterwards, rather than silently blocked by
  // `required` on a field the reset had emptied.
  await row.locator('input[name="inputPricePerMillion"]').fill("abc");
  await row.getByRole("button", { name: m.educator_save() }).click();

  // A sentence an educator can act on, not valibot's internal wording.
  await expect(row.getByRole("alert")).toHaveText(m.validation_price_not_a_number());

  // The rejected value is still there to correct, and the database never took it.
  await expect(row.locator('input[name="inputPricePerMillion"]')).toHaveValue("abc");
  await page.reload();
  await expect(row.locator('input[name="name"]')).toHaveValue(name);
  await expect(row.locator('input[name="inputPricePerMillion"]')).toHaveValue("");

  // Leave the shared database as this suite found it.
  await row.getByRole("button", { name: m.educator_allowlist_disallow() }).click();
  await expect(rows).toHaveCount(rowsBefore);
});
