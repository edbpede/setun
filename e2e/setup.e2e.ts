import { readFile, stat } from "node:fs/promises";
import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import * as m from "../src/lib/paraglide/messages";
import { SETUP_ORIGIN, SETUP_TOKEN_PATH } from "../playwright.config";

/**
 * First-run setup, end to end (plan 6, PRD §6.2, §7, §8, §9, §21, §22).
 *
 * This suite runs against its own server on its own port with its own cold
 * database and **no seed credentials** — the opposite starting state from every
 * other suite here. That is the only way to exercise the gate: an installation
 * with a seeded educator is adopted at boot and never sees `/setup` at all.
 *
 * The token is read from the file sink rather than from the console, because
 * Playwright gives a suite no access to a `webServer` child's stdout. There is
 * deliberately no endpoint that would return it.
 *
 * Serial, and in this order, because setup happens once: after the last test the
 * installation is set up and `/setup` is gone for good.
 */

test.describe.configure({ mode: "serial" });

const EDUCATOR = { username: "opsaetter", password: "et-langt-nok-kodeord" };
const CLASSROOM = "E2E opsætning";

/**
 * One browser for the whole suite.
 *
 * The claim is per-browser by design — that is what the `409` below is about —
 * so a fresh context per test would be a fresh browser that does not hold the
 * setup, and every test after the first would be locked out of its own suite.
 */
let context: BrowserContext;
let operator: Page;

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext({ baseURL: SETUP_ORIGIN });
  operator = await context.newPage();
});

test.afterAll(async () => {
  await context.close();
});

/**
 * The token boot printed.
 *
 * Boot is lazy — `services ??= boot()` — so the token exists once the server has
 * answered its first request. Playwright's own readiness probe is that request,
 * but the poll makes the ordering explicit rather than assumed.
 */
async function readBootstrapToken(): Promise<string> {
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      await stat(SETUP_TOKEN_PATH);
      return (await readFile(SETUP_TOKEN_PATH, "utf8")).trim();
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(`no bootstrap token was written to ${SETUP_TOKEN_PATH}`);
}

test("an unconfigured Setun sends every path to the wizard (§6.2)", async ({ page }) => {
  for (const path of ["/", "/dashboard", "/login", "/educator/login", "/chat"]) {
    const response = await page.goto(path);
    expect(response?.status(), path).toBe(200);
    await expect(page).toHaveURL(/\/setup$/);
  }

  // The surface carries a one-time credential field; nothing may cache or index it.
  const setup = await page.goto("/setup");
  expect(setup?.headers()["cache-control"]).toContain("no-store");
  expect(setup?.headers()["x-robots-tag"]).toContain("noindex");
});

test("a wrong or malformed token is refused, and the right one claims setup (§7, §21)", async () => {
  const token = await readBootstrapToken();

  await operator.goto("/setup");
  await operator.getByLabel(m.setup_claim_token_label()).fill("2345-6789-ABCD-EFGH-JKMN-PQRS");
  await operator.getByRole("button", { name: m.setup_claim_submit() }).click();
  await expect(operator.getByText(m.setup_error_invalid_token())).toBeVisible();

  // The active token survives a wrong guess: only completion or expiry clears it.
  await operator.getByLabel(m.setup_claim_token_label()).fill(token);
  await operator.getByRole("button", { name: m.setup_claim_submit() }).click();
  await expect(operator.getByRole("heading", { name: m.setup_educator_title() })).toBeVisible();
});

test("a second browser is refused with 409 while the claim is live (§7)", async ({ browser }) => {
  const token = await readBootstrapToken();
  const context = await browser.newContext();

  // Asserted at the API rather than in the UI: the status is the contract, and
  // `Accept: text/html` is what makes SvelteKit answer with it rather than with
  // an enhanced-form envelope.
  const response = await context.request.post(`${SETUP_ORIGIN}/setup?/claim`, {
    headers: { origin: SETUP_ORIGIN, accept: "text/html" },
    form: { token },
  });

  expect(response.status()).toBe(409);
  await context.close();
});

test("the wizard takes a cold install to a working classroom, then closes (§6.2, §8, §9)", async ({
  browser,
}) => {
  const page = operator;
  await page.goto("/setup");

  // --- Step 1: the operator account ---
  await expect(page.getByRole("heading", { name: m.setup_educator_title() })).toBeVisible();
  await page.getByLabel(m.educator_username_label()).fill(EDUCATOR.username);
  await page.getByLabel(m.educator_password_label(), { exact: true }).fill(EDUCATOR.password);
  await page.getByLabel(m.setup_confirm_password_label()).fill("noget-andet");
  await page.getByRole("button", { name: m.setup_educator_submit() }).click();
  // A password typed wrong twice is the failure mode "no reset path" describes.
  await expect(page.getByText("The two passwords are not the same")).toBeVisible();

  await page.getByLabel(m.setup_confirm_password_label()).fill(EDUCATOR.password);
  await page.getByRole("button", { name: m.setup_educator_submit() }).click();

  // --- Step 2: the gateway, live ---
  await expect(page).toHaveURL(/step=gateway/);
  // The stub gateway answers `/v1/models`, so the live probe reports it as
  // reachable — and the button says "Continue" rather than "Continue anyway".
  await expect(page.getByText(m.setup_gateway_ok_note())).toBeVisible();
  await page.getByRole("button", { name: m.setup_continue(), exact: true }).click();

  // --- Step 3: the first model alias ---
  await expect(page).toHaveURL(/step=alias/);
  await page.getByLabel(m.educator_alias_name_label()).fill("Balanceret");
  await page.getByLabel(m.educator_alias_gateway_label()).fill("stub-model");
  await page.getByRole("button", { name: m.setup_alias_submit() }).click();

  // --- Step 4: the first classroom, with §16's confirmation ---
  await expect(page).toHaveURL(/step=classroom/);
  await page.getByLabel(m.educator_classroom_name_label()).fill(CLASSROOM);
  await page.getByRole("button", { name: m.setup_classroom_submit() }).click();
  // The alias carries no data processing agreement, so the grant is refused
  // until the educator says what it means (§16).
  await expect(page.getByText(m.setup_error_no_dpa_unconfirmed())).toBeVisible();

  await page.getByLabel(m.setup_classroom_no_dpa_confirm()).check();
  await page.getByRole("button", { name: m.setup_classroom_submit() }).click();

  // --- Step 5: a first batch of pupils ---
  await expect(page).toHaveURL(/step=students/);
  await page.getByLabel(m.educator_provision_count_label()).fill("3");
  await page.getByRole("button", { name: m.educator_provision_submit() }).click();
  await expect(page.getByText(m.educator_cards_once())).toBeVisible();

  const codes = await page.locator("li code").allInnerTexts();
  expect(codes).toHaveLength(3);
  expect(new Set(codes).size).toBe(3);

  // --- Finish ---
  await page.getByRole("link", { name: m.setup_continue(), exact: true }).click();
  await expect(page).toHaveURL(/step=finish/);
  await page.getByRole("button", { name: m.setup_finish_submit() }).click();

  // The educator lands in the panel already signed in — a session issued at the
  // end, against a cookie the finish action deleted first (§21).
  await expect(page).toHaveURL(/\/educator$/);
  // Named in the panel's sidebar and on its dashboard; either proves the point.
  await expect(page.getByText(CLASSROOM).first()).toBeVisible();

  // --- The gate is transparent, and the wizard is gone ---
  const gone = await page.goto("/setup");
  expect(gone?.status()).toBe(404);

  const anonymous = await browser.newContext({ baseURL: SETUP_ORIGIN });
  const visitor = await anonymous.newPage();
  await visitor.goto("/dashboard");
  await expect(visitor).toHaveURL(/\/login$/);

  // A provisioned code is a working credential at the real login endpoint.
  await visitor.getByLabel(m.login_code_label()).fill(codes[0]);
  await visitor.getByRole("button", { name: m.login_submit() }).click();
  await expect(visitor).toHaveURL(/\/chat/);
  await anonymous.close();

  // The token's second sink is unlinked on completion, not merely forgotten.
  await expect(stat(SETUP_TOKEN_PATH)).rejects.toThrow();
});

test("every setup action refuses on its own guard once setup is complete (§21)", async ({
  request,
}) => {
  for (const action of ["claim", "recover", "educator", "alias", "classroom", "finish"]) {
    const response = await request.post(`${SETUP_ORIGIN}/setup?/${action}`, {
      headers: { origin: SETUP_ORIGIN, accept: "text/html" },
      form: { token: "irrelevant" },
    });

    // 404, not 403: a 403 would confirm the surface is still there.
    expect(response.status(), action).toBe(404);
  }
});
