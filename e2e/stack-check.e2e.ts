import { expect, test } from "@playwright/test";

/**
 * The stack validation route is development tooling and must not ship (§21).
 *
 * This suite ran against the route until it was gated on `dev`; it now asserts
 * the gate instead. Playwright builds the application for real before serving
 * it, so this is the only place that can tell whether a production build still
 * answers on `/stack-check` — a component spec runs under Vite and would pass
 * either way.
 *
 * What the page itself renders is covered by
 * `src/lib/components/stack-check/StackCheckPanel.svelte.spec.ts`, which
 * asserts the colour tokens, the radius scale and the dialog behaviour rather
 * than merely that a heading appears.
 */
test("does not serve the stack validation route from a production build", async ({ page }) => {
  const response = await page.goto("/stack-check");

  expect(response?.status()).toBe(404);
});
