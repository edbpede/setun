import { type Browser, expect, type Page, test } from "@playwright/test";
import * as m from "../src/lib/paraglide/messages";
import { E2E_EDUCATOR_PASSWORD, E2E_EDUCATOR_USERNAME } from "../playwright.config";
import { clearLoginWindow } from "./support/login-window";

/**
 * The educator flow of §22, end to end (plan 5.1, PRD §7, §17, §22).
 *
 * "An educator creating a classroom, provisioning students, opening, locking,
 * and rotating a credential — all asserted at the API level, not only in the
 * UI."
 *
 * So every credential claim below is settled by using the code, not by reading
 * the screen: the provisioned code signs a pupil in, the rotated one signs them
 * in, and the code it replaced is refused. The panel is how the educator gets
 * there; the API is what says whether it worked.
 *
 * This suite creates its own classroom per run, so nothing it opens, locks or
 * provisions reaches a room another suite is chatting in.
 */

/**
 * Appendix A caps one IP at 30 login attempts per 15 minutes, and every worker
 * here is loopback. Cleared per test so the suites do not fail each other's
 * sign-ins; the limiter itself is asserted in `bun test` (§7, §22).
 */
test.beforeEach(clearLoginWindow);

test.describe.configure({ mode: "serial" });

const CLASSROOM = `E2E educator ${Date.now()}`;

async function signIn(page: Page): Promise<void> {
  await page.goto("/educator/login");
  await page.getByLabel(m.educator_username_label()).fill(E2E_EDUCATOR_USERNAME);
  await page.getByLabel(m.educator_password_label()).fill(E2E_EDUCATOR_PASSWORD);
  await page.getByRole("button", { name: m.educator_login_submit() }).click();
  await expect(page).toHaveURL(/\/educator$/);
}

/**
 * Try a code at the real login endpoint, in a browser context of its own.
 *
 * A separate context per attempt, because the question is always whether *this
 * code* authenticates — a cookie left over from a previous attempt would answer
 * a different one.
 */
async function codeSignsIn(browser: Browser, code: string): Promise<boolean> {
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto("/login");
  await page.getByLabel(m.login_code_label()).fill(code);
  await page.getByRole("button", { name: m.login_submit() }).click();

  const signedIn = await page
    .waitForURL(/\/chat/, { timeout: 5_000 })
    .then(() => true)
    .catch(() => false);

  await context.close();
  return signedIn;
}

test("an educator creates a classroom, provisions pupils, opens, locks and rotates (§17, §22)", async ({
  page,
  browser,
}) => {
  await signIn(page);

  // --- Create ---
  await page.getByLabel(m.educator_classroom_name_label()).fill(CLASSROOM);
  await page.getByRole("button", { name: m.educator_create_classroom() }).click();
  await expect(page).toHaveURL(/\/educator\/classrooms\//);

  const classroomUrl = page.url();

  // --- Provision a batch, and read the cards ---
  await page.getByRole("link", { name: m.educator_nav_roster() }).click();
  await page.getByLabel(m.educator_provision_count_label()).fill("3");
  await page.getByRole("button", { name: m.educator_provision_submit() }).click();

  // "The code is shown at provisioning and rotation only" (§7): the cards are in
  // this response and nowhere else.
  await expect(page.getByText(m.educator_cards_once())).toBeVisible();
  const cards = page.locator("li", { has: page.locator("code") });
  const codes = await cards.locator("code").allInnerTexts();
  expect(codes).toHaveLength(3);

  // Distinct codes from a CSPRNG, not a sequence (§7, §21).
  expect(new Set(codes).size).toBe(3);

  // The card names the pupil it belongs to, so the rotation below can name the
  // same one rather than trusting two lists to be in the same order.
  const labels = await cards.locator("span.font-semibold").allInnerTexts();
  expect(labels).toHaveLength(3);

  // --- The code works, at the login endpoint ---
  expect(await codeSignsIn(browser, codes[0])).toBe(true);

  // --- Reloading the roster does not show a code again (§7) ---
  await page.reload();
  await expect(page.getByText(m.educator_cards_once())).toHaveCount(0);
  await expect(page.locator("code")).toHaveCount(0);

  // --- Open, then lock ---
  await page.goto(classroomUrl);
  await page.getByRole("button", { name: m.educator_open_now() }).click();
  await expect(page.getByText(m.educator_state_open(), { exact: true })).toBeVisible();

  await page.getByRole("button", { name: m.educator_lock_classroom() }).click();
  await expect(page.getByText(m.educator_state_locked(), { exact: true })).toBeVisible();

  // --- Rotate: the new code works and the old one is refused (§7, §21) ---
  await page.goto(`${classroomUrl}/roster`);
  await page
    .getByRole("listitem")
    .filter({ hasText: labels[0] })
    .getByRole("button", { name: m.educator_student_rotate() })
    .click();
  await expect(page.getByText(m.educator_cards_once())).toBeVisible();

  const rotated = (await page.locator("code").allInnerTexts())[0];
  expect(rotated).not.toBe(codes[0]);

  // The rotated code is the credential now; the one it replaced is not.
  expect(await codeSignsIn(browser, rotated)).toBe(true);
  expect(await codeSignsIn(browser, codes[0])).toBe(false);
});

test("a removed pupil leaves the roster, and a disabled one cannot sign in (§16, §21)", async ({
  page,
  browser,
}) => {
  await signIn(page);

  const name = `E2E roster ${Date.now()}`;
  await page.getByLabel(m.educator_classroom_name_label()).fill(name);
  await page.getByRole("button", { name: m.educator_create_classroom() }).click();
  await page.getByRole("link", { name: m.educator_nav_roster() }).click();

  await page.getByLabel(m.educator_provision_count_label()).fill("2");
  await page.getByRole("button", { name: m.educator_provision_submit() }).click();
  await expect(page.getByText(m.educator_cards_once())).toBeVisible();

  const cards = page.locator("li", { has: page.locator("code") });
  const codes = await cards.locator("code").allInnerTexts();
  // By label rather than by position: the roster is ordered by label and the
  // cards by the order they were minted, which are not the same order.
  const labels = await cards.locator("span.font-semibold").allInnerTexts();

  // Disabling stops the credential working at once (§7, §21).
  await page
    .getByRole("listitem")
    .filter({ hasText: labels[0] })
    .getByRole("button", { name: m.educator_student_disable() })
    .click();
  await expect(page.getByText(m.educator_status_disabled(), { exact: true })).toBeVisible();

  expect(await codeSignsIn(browser, codes[0])).toBe(false);

  // Removal takes the other pupil off the roster; their work is untouched (§16).
  await page
    .getByRole("listitem")
    .filter({ hasText: labels[1] })
    .getByRole("button", { name: m.educator_student_remove() })
    .click();
  await expect(page.getByRole("button", { name: m.educator_student_remove() })).toHaveCount(1);

  await page.getByRole("link", { name: m.educator_show_removed() }).click();
  await expect(page.getByText(m.educator_status_removed(), { exact: true })).toBeVisible();
});

test("deleting a classroom restores the dashboard title", async ({ page }) => {
  await signIn(page);

  const name = `E2E delete ${Date.now()}`;
  await page.getByLabel(m.educator_classroom_name_label()).fill(name);
  await page.getByRole("button", { name: m.educator_create_classroom() }).click();
  await expect(page).toHaveURL(/\/educator\/classrooms\//);

  await page.getByRole("link", { name: m.educator_nav_settings() }).click();
  await page.getByLabel(m.educator_delete_classroom_confirm_label()).fill(name);
  await page.getByRole("button", { name: m.educator_delete_classroom_submit() }).click();

  await expect(page).toHaveURL(/\/educator$/);
  await expect(page).toHaveTitle(`${m.educator_panel_title()} · ${m.app_name()}`);
});
