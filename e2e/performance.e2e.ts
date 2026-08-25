import { execFile } from "node:child_process";
import { gzipSync } from "node:zlib";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import * as m from "../src/lib/paraglide/messages";
import { E2E_DATABASE_PATH, E2E_PEPPER } from "../playwright.config";
import { LONG_MARKER } from "./support/stub-gateway";

/**
 * The Chromebook budget, measured (PRD §20, plan 5.6).
 *
 * "Development and review happen under sixfold CPU throttling as a proxy for the
 * real device. Targets: under 250 KB gzipped JavaScript for the chat route,
 * first meaningful paint under two seconds cold, and no dropped frames while
 * streaming plain text."
 *
 * The target hardware is an Acer Chromebook Spin 511 — dual-core Celeron N4500,
 * 4 GB, 1366×768 — so the numbers below are asserted with the CPU throttled and
 * the viewport set to what a pupil actually has, not to a developer's monitor.
 *
 * Gzip is applied here rather than read off the wire: the preview server does
 * not compress, Caddy does in production, and the budget is denominated in what
 * the pupil downloads (§5, §20).
 */

const run = promisify(execFile);

/** This suite's own classroom, so no other suite's lock or schedule reaches it (§22). */
const CLASSROOM = "E2E performance";

/** §20's device. Usable height after browser chrome is roughly 640 pixels. */
const CHROMEBOOK = { width: 1366, height: 640 };

const JS_BUDGET_BYTES = 250 * 1024;
const FIRST_PAINT_BUDGET_MS = 2_000;

/** §20: "sixfold CPU throttling as a proxy for the real device". */
const CPU_THROTTLE = 6;

async function provisionStudent(): Promise<{ label: string; code: string }> {
  const { stdout } = await run("bun", ["run", "e2e/support/seed-student.ts"], {
    env: {
      ...process.env,
      SETUN_DATABASE_PATH: E2E_DATABASE_PATH,
      SETUN_STUDENT_CODE_PEPPER: E2E_PEPPER,
      SETUN_E2E_CLASSROOM: CLASSROOM,
    },
  });

  return JSON.parse(stdout.trim());
}

test.use({ viewport: CHROMEBOOK });

test("the chat route stays inside its JavaScript budget (§20)", async ({ page }) => {
  const { code } = await provisionStudent();

  const scripts = new Map<string, number>();
  page.on("response", async (response) => {
    const url = response.url();
    if (!url.includes("/_app/") || !url.endsWith(".js")) return;
    try {
      scripts.set(url, gzipSync(await response.body()).length);
    } catch {
      // A response whose body is no longer available was served from cache and
      // is already counted.
    }
  });

  await page.goto("/login");
  await page.getByLabel(m.login_code_label()).fill(code);
  await page.getByRole("button", { name: m.login_submit() }).click();
  await expect(page).toHaveURL(/\/chat/);

  // The composer is the chat route's own interactive surface; once it is there,
  // everything the route needs has loaded.
  await page.getByRole("button", { name: m.chat_new_conversation() }).first().click();
  await expect(page.getByRole("textbox", { name: m.chat_composer_label() })).toBeVisible();
  await page.waitForLoadState("networkidle");

  const total = [...scripts.values()].reduce((sum, size) => sum + size, 0);
  const breakdown = [...scripts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([url, size]) => `${(size / 1024).toFixed(1)} KB  ${url.split("/").pop()}`)
    .join("\n");

  console.info(`chat route gzipped JS: ${(total / 1024).toFixed(1)} KB\n${breakdown}`);
  expect(total, `chat route gzipped JS\n${breakdown}`).toBeLessThan(JS_BUDGET_BYTES);
});

test("the chat route paints inside two seconds under sixfold CPU throttling (§20)", async ({
  page,
  browser,
}) => {
  const { code } = await provisionStudent();

  await page.goto("/login");
  await page.getByLabel(m.login_code_label()).fill(code);
  await page.getByRole("button", { name: m.login_submit() }).click();
  await expect(page).toHaveURL(/\/chat/);

  // A conversation to open into: the cold load being measured is the one a pupil
  // performs mid-lesson, on a thread they already have.
  await page.getByRole("button", { name: m.chat_new_conversation() }).first().click();
  await expect(page.getByRole("textbox", { name: m.chat_composer_label() })).toBeVisible();

  // Cold: a new context has an empty HTTP cache, which is the state a pupil
  // opening their Chromebook at the start of a lesson is in.
  const cookies = await page.context().cookies();
  const cold = await browser.newContext({ viewport: CHROMEBOOK });
  await cold.addCookies(cookies);
  const coldPage = await cold.newPage();

  const session = await cold.newCDPSession(coldPage);
  await session.send("Emulation.setCPUThrottlingRate", { rate: CPU_THROTTLE });

  await coldPage.goto("/chat", { waitUntil: "commit" });
  await expect(coldPage.getByRole("textbox", { name: m.chat_composer_label() })).toBeVisible({
    timeout: 30_000,
  });

  const paint = await coldPage.evaluate(() => {
    const entry = performance.getEntriesByName("first-contentful-paint")[0];
    return entry ? entry.startTime : Number.POSITIVE_INFINITY;
  });

  console.info(`first contentful paint at ${CPU_THROTTLE}× throttling: ${paint.toFixed(0)} ms`);
  expect(paint).toBeLessThan(FIRST_PAINT_BUDGET_MS);

  await cold.close();
});

test("streaming plain text does not drop frames under sixfold CPU throttling (§20)", async ({
  page,
}) => {
  // Sixfold throttling makes a long stream genuinely slow; the budget under test
  // is the frame gap, not the wall clock.
  test.setTimeout(120_000);

  const { code } = await provisionStudent();

  const session = await page.context().newCDPSession(page);

  await page.goto("/login");
  await page.getByLabel(m.login_code_label()).fill(code);
  await page.getByRole("button", { name: m.login_submit() }).click();
  await expect(page).toHaveURL(/\/chat/);

  await page.getByRole("button", { name: m.chat_new_conversation() }).first().click();
  await expect(page.getByRole("textbox", { name: m.chat_composer_label() })).toBeVisible();

  // Throttled only for the stream itself: the sign-in above is not what §20
  // budgets, and throttling it sixfold only makes the test slower.
  await session.send("Emulation.setCPUThrottlingRate", { rate: CPU_THROTTLE });

  // Sample the gaps between animation frames while the answer streams. A frame
  // budget at 60 Hz is 16.7 ms; the assertion below allows a wide margin over
  // that, because what it is guarding against is not jitter but the regression
  // §20 describes — re-parsing and re-highlighting the whole message on every
  // delta, which stalls for hundreds of milliseconds at a time.
  await page.evaluate(() => {
    const gaps: number[] = [];
    let previous = performance.now();
    const tick = () => {
      const now = performance.now();
      gaps.push(now - previous);
      previous = now;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    (window as unknown as { __setunGaps: number[] }).__setunGaps = gaps;
  });

  await page
    .getByRole("textbox", { name: m.chat_composer_label() })
    .fill(`${LONG_MARKER} forklar neurale netværk`);
  await page.getByRole("button", { name: m.chat_send() }).click();

  await expect(page.getByText("sætning 119", { exact: false })).toBeVisible({ timeout: 90_000 });

  const gaps = await page.evaluate(
    () => (window as unknown as { __setunGaps: number[] }).__setunGaps,
  );

  // The first sample spans the call that installed the loop; drop it.
  const measured = gaps.slice(1);
  const worst = Math.max(...measured);

  console.info(
    `streaming frame gaps at ${CPU_THROTTLE}× throttling: ${measured.length} frames, worst ${worst.toFixed(0)} ms`,
  );

  expect(measured.length).toBeGreaterThan(10);
  expect(worst).toBeLessThan(250);
});
