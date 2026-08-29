import { expect, test } from "@playwright/test";
import { SANDBOX_ORIGIN } from "../playwright.config";
import { mountArtifact } from "./support/artifact-host";

/**
 * The two artifact tiers, on the origin that runs them (plan 4.1, 4.5; PRD §13).
 *
 * Driven through the sandbox's own message protocol rather than through a
 * conversation: what is under test is the runner, the compiler worker and the
 * pinned runtimes, and routing that through a model would only add a way for the
 * test to fail for an unrelated reason.
 */

test("a static artifact renders with no compiler fetched at all", async ({ page }) => {
  const fetched: string[] = [];
  page.on("request", (request) => fetched.push(request.url()));

  await page.goto("/login");

  const stage = await mountArtifact(page, {
    language: "html",
    source: '<!doctype html><html><body><p id="out">Statisk side</p></body></html>',
  });

  await expect(stage.locator("#out")).toHaveText("Statisk side");

  // "Most classroom work lands here, and it costs nothing to run" (§13): the
  // compiler is fetched only when a student first opens a non-static artifact.
  expect(fetched.some((url) => url.endsWith(".wasm"))).toBe(false);
});

test("an SVG artifact renders", async ({ page }) => {
  await page.goto("/login");

  const stage = await mountArtifact(page, {
    language: "svg",
    source: '<svg viewBox="0 0 10 10"><title id="out">En cirkel</title><circle cx="5" cy="5" r="4"/></svg>',
  });

  await expect(stage.locator("circle")).toHaveCount(1);
});

test("utility classes come from the self-hosted UnoCSS runtime, not a CDN", async ({ page }) => {
  const external: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    // Only schemes that can reach a server. The runtimes are handed to the
    // artifact as source and loaded from `blob:` URLs it makes itself (§13,
    // §14), and a blob has no host to be off-origin from — counting one as
    // external would make this assert the opposite of what it means.
    if (url.protocol !== "http:" && url.protocol !== "https:") return;
    if (!url.hostname.endsWith("localhost") && url.hostname !== "127.0.0.1") {
      external.push(request.url());
    }
  });

  await page.goto("/login");

  const stage = await mountArtifact(page, {
    language: "html",
    source: '<p id="out" class="text-red-500">Farvet</p>',
  });

  // The runtime generates the rule after the document parses, so a colour other
  // than the initial one is the assertion that it ran at all. The exact computed
  // string is the browser's business — Chrome reports oklch colours as oklab.
  await expect
    .poll(() => stage.locator("#out").evaluate((node) => getComputedStyle(node).color))
    .not.toBe("rgb(0, 0, 0)");
  expect(external, "no public CDN is contacted in normal operation").toEqual([]);
});

test("a tsx artifact compiles and runs on the self-hosted React runtime", async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto("/login");

  const stage = await mountArtifact(page, {
    language: "tsx",
    source: [
      'import { useState } from "react";',
      "",
      "export default function App() {",
      "  const [count] = useState<number>(7);",
      '  return <p id="out">React siger {count}</p>;',
      "}",
    ].join("\n"),
  });

  await expect(stage.locator("#out")).toHaveText("React siger 7", { timeout: 60_000 });
});

test("a svelte artifact compiles and runs on the self-hosted Svelte runtime", async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto("/login");

  const stage = await mountArtifact(page, {
    language: "svelte",
    source: [
      "<script lang=\"ts\">",
      "  let count: number = $state(3);",
      "</script>",
      "",
      '<p id="out">Svelte siger {count}</p>',
    ].join("\n"),
  });

  await expect(stage.locator("#out")).toHaveText("Svelte siger 3", { timeout: 60_000 });
});

test("a build failure is reported as text, not as a broken frame", async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto("/login");

  const failures: string[] = [];
  await page.exposeFunction("recordArtifactFailure", (message: string) => failures.push(message));
  await page.evaluate(() => {
    window.addEventListener("message", (event) => {
      const data = event.data as { channel?: string; type?: string; message?: string };
      if (data?.channel === "setun-artifact" && data.type === "failed") {
        (window as unknown as { recordArtifactFailure: (m: string) => void }).recordArtifactFailure(
          data.message ?? "",
        );
      }
    });
  });

  await mountArtifact(page, { language: "tsx", source: "export default function App( {" });

  await expect.poll(() => failures.length, { timeout: 60_000 }).toBeGreaterThan(0);
  // The compiler's own words: this is what a pupil debugging their code reads.
  expect(failures[0].length).toBeGreaterThan(0);
});

test("the pinned runtimes are served from the sandbox origin", async ({ request }) => {
  // "Pinned self-hosted ESM runtimes — React and Svelte only" (§13).
  for (const runtime of [
    "react.js",
    "react-dom-client.js",
    "react-jsx-runtime.js",
    "svelte.js",
    "svelte-internal-client.js",
    "unocss.js",
  ]) {
    const response = await request.get(`${SANDBOX_ORIGIN}/runtimes/${runtime}`);
    expect(response.status(), runtime).toBe(200);
    // Reachable from an opaque origin, which is what the runner document has.
    expect(response.headers()["access-control-allow-origin"]).toBe("*");
  }
});
