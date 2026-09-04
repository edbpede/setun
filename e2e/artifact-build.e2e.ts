import { expect, test } from "@playwright/test";
import { SANDBOX_ORIGIN } from "../playwright.config";
import {
  focusArtifact,
  mountArtifact,
  rerenderArtifact,
  sandboxMessageTypes,
} from "./support/artifact-host";

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

test("a page that mounted and then threw is not reported as one that failed", async ({
  page,
}) => {
  await page.goto("/login");

  await mountArtifact(page, {
    language: "html",
    source: [
      '<!doctype html><html><body><p id="out">Siden kører</p><script>',
      'setTimeout(function () { throw new Error("boom") }, 0);',
      "</script></body></html>",
    ].join("\n"),
  });

  // The page is on the pupil's screen. Calling this "did not run" told the model
  // to rewrite a file that works, and lost the error worth fixing (§13).
  await expect.poll(() => sandboxMessageTypes(page), { timeout: 20_000 }).toContain("threw");

  const types = await sandboxMessageTypes(page);
  expect(types).not.toContain("failed");
  expect(types.indexOf("rendered")).toBeGreaterThan(-1);
  expect(types.indexOf("rendered")).toBeLessThan(types.indexOf("threw"));
});

test("a page that throws before it mounts is still a failure", async ({ page }) => {
  await page.goto("/login");

  await mountArtifact(page, {
    language: "html",
    source: [
      '<!doctype html><html><body><p id="out">…</p>',
      '<script>throw new Error("early")</script>',
      "</body></html>",
    ].join("\n"),
  });

  await expect.poll(() => sandboxMessageTypes(page), { timeout: 20_000 }).toContain("failed");

  // The ack script sits after the body, so the mount that follows the throw does
  // not take the failure back: the first terminal word per run wins.
  expect(await sandboxMessageTypes(page)).not.toContain("rendered");
});

test("a component that throws while rendering is a failure, not a late throw", async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto("/login");

  await mountArtifact(page, {
    language: "tsx",
    source: [
      "export default function App() {",
      '  throw new Error("i render");',
      "}",
    ].join("\n"),
  });

  // React's `render()` schedules, so without a synchronous mount this threw
  // *after* the harness had acked and was reported as a page that ran (§13).
  await expect.poll(() => sandboxMessageTypes(page), { timeout: 60_000 }).toContain("failed");
  expect(await sandboxMessageTypes(page)).not.toContain("rendered");
});

test("a component that throws a falsy value is a failure too", async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto("/login");

  await mountArtifact(page, {
    language: "tsx",
    source: ["export default function App() {", "  throw null;", "}"].join("\n"),
  });

  // `throw null` is legal. A harness that decided on the caught value rather
  // than on whether the crash handler fired read it as no crash at all, acked
  // the mount, and told the pupil a component that rendered nothing had run.
  await expect.poll(() => sandboxMessageTypes(page), { timeout: 60_000 }).toContain("failed");
  expect(await sandboxMessageTypes(page)).not.toContain("rendered");
});

/** A page that keeps a running total in `localStorage`, which is what a game does. */
const SCORE_KEEPER = [
  "<!doctype html><html><body><p id=\"out\">…</p><script>",
  'var score = Number(localStorage.getItem("score") || 0) + 1;',
  'localStorage.setItem("score", String(score));',
  'document.getElementById("out").textContent = "point:" + score;',
  "</script></body></html>",
].join("\n");

test("what an artifact saves survives a Run, and its neighbour starts empty", async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto("/login");

  // The frame's origin is opaque, where `localStorage` *throws* — so before the
  // shim this page died on its first line rather than counting (§13).
  const stage = await mountArtifact(page, {
    language: "html",
    source: SCORE_KEEPER,
    artifactId: "spillet",
  });
  await expect(stage.locator("#out")).toHaveText("point:1", { timeout: 20_000 });

  // Kept per artifact: the thing beside it does not read its neighbour's score.
  //
  // Run before the second go at `spillet` on purpose. The shim posts its
  // snapshot on a 250 ms debounce *and* on `pagehide`, and replacing the frame
  // here is what fires the second — so what the next step reads back is carried
  // by the frame's own teardown rather than by whether a timer beat a sleep.
  const other = await rerenderArtifact(page, {
    language: "html",
    source: SCORE_KEEPER,
    artifactId: "noget-andet",
  });
  await expect(other.locator("#out")).toHaveText("point:1", { timeout: 20_000 });

  const again = await rerenderArtifact(page, {
    language: "html",
    source: SCORE_KEEPER,
    artifactId: "spillet",
  });
  await expect(again.locator("#out")).toHaveText("point:2", { timeout: 20_000 });

  // And none of it reached the application (§13, §14).
  expect(await sandboxMessageTypes(page)).not.toContain("storage");
});

test("the keyboard reaches an artifact the pupil has focused", async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto("/login");

  // A canvas game listens on its own window, so this is the difference between
  // a playable artifact and one that ignores every arrow key (§13, §20).
  const stage = await mountArtifact(page, {
    language: "html",
    source: [
      '<!doctype html><html><body><p id="out">ingen</p><script>',
      'addEventListener("keydown", function (event) {',
      '  document.getElementById("out").textContent = "tast:" + event.key;',
      "});",
      "</script></body></html>",
    ].join("\n"),
  });

  await expect(stage.locator("#out")).toHaveText("ingen", { timeout: 20_000 });

  // Take the keyboard back to the application first. The runner focuses the
  // frame itself when a render mounts, so without this the artifact already has
  // the keyboard and the assertion below would pass with no focus protocol at
  // all — which is the thing this test exists to hold.
  await page.evaluate(() => {
    const probe = document.createElement("button");
    probe.id = "e2e-focus-probe";
    document.body.append(probe);
    probe.focus();
  });

  await focusArtifact(page);
  await page.keyboard.press("ArrowRight");

  await expect(stage.locator("#out")).toHaveText("tast:ArrowRight", { timeout: 20_000 });
});

test("what an artifact prints reaches the application as text", async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto("/login");

  const printed: { level: string; text: string }[] = [];
  await page.exposeFunction("recordConsole", (lines: { level: string; text: string }[]) => {
    printed.push(...lines);
  });
  await page.evaluate(() => {
    window.addEventListener("message", (event) => {
      const data = event.data as { channel?: string; type?: string; lines?: unknown };
      if (data?.channel === "setun-artifact" && data.type === "console") {
        (window as unknown as { recordConsole: (l: unknown) => void }).recordConsole(data.lines);
      }
    });
  });

  await mountArtifact(page, {
    language: "html",
    source: [
      "<!doctype html><html><body><script>",
      'console.log("point:", 3);',
      'console.warn("<b>ikke markup</b>");',
      "</script></body></html>",
    ].join("\n"),
  });

  await expect.poll(() => printed.length, { timeout: 20_000 }).toBeGreaterThanOrEqual(2);
  expect(printed.map((line) => line.text)).toContain("point: 3");
  // Generated output, so it crosses as text at every hop and is rendered as text.
  expect(printed.find((line) => line.level === "warn")?.text).toBe("<b>ikke markup</b>");
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

/**
 * An artifact is a small project of files (PRD §13).
 *
 * The bundler is what makes that true: entry points live in an esbuild namespace
 * with no filesystem behind them, and the plugin is the whole of the resolution.
 */
test("a tsx project bundles its own modules, data and styles", async ({ page }) => {
  await page.goto("/login");

  const stage = await mountArtifact(page, {
    language: "tsx",
    entry: "src/App.tsx",
    files: {
      "src/App.tsx": [
        'import { LABELS } from "./data";',
        'import config from "./config.json";',
        'import "./styles.css";',
        "export default function App() {",
        '  return <p id="out" className="malet">{LABELS[0]} — {config.title}</p>;',
        "}",
      ].join("\n"),
      "src/data.ts": 'export const LABELS: string[] = ["Klik"];',
      "src/config.json": '{"title":"Tidslinje"}',
      "src/styles.css": ".malet { color: rgb(0, 128, 128) }",
    },
  });

  await expect(stage.locator("#out")).toHaveText("Klik — Tidslinje");
  // The stylesheet travelled as its own esbuild output and was injected into the
  // document, rather than arriving inside the module.
  await expect(stage.locator("#out")).toHaveCSS("color", "rgb(0, 128, 128)");
});

test("a svelte child component compiles with its own styles", async ({ page }) => {
  await page.goto("/login");

  const stage = await mountArtifact(page, {
    language: "svelte",
    entry: "App.svelte",
    files: {
      "App.svelte": [
        "<script>",
        '  import Badge from "./Badge.svelte";',
        "</script>",
        "<Badge />",
      ].join("\n"),
      "Badge.svelte": [
        '<span id="out" class="badge">Færdig</span>',
        "<style>.badge { color: rgb(0, 128, 128) }</style>",
      ].join("\n"),
    },
  });

  await expect(stage.locator("#out")).toHaveText("Færdig");
  await expect(stage.locator("#out")).toHaveCSS("color", "rgb(0, 128, 128)");
});

/**
 * There is no network in the frame, so an import outside the pinned runtimes
 * would otherwise fail at run time with a message about a module specifier.
 */
test("an import from outside the project is refused by name", async ({ page }) => {
  await page.goto("/login");

  await mountArtifact(page, {
    language: "tsx",
    entry: "App.tsx",
    files: {
      "App.tsx": 'import confetti from "canvas-confetti";\nexport default () => <p>{confetti}</p>;',
    },
  });

  await expect
    .poll(async () => (await sandboxMessageTypes(page)).includes("failed"))
    .toBe(true);
});

test("a relative import naming nothing lists the files the project does hold", async ({ page }) => {
  await page.goto("/login");

  await mountArtifact(page, {
    language: "tsx",
    entry: "App.tsx",
    files: {
      "App.tsx": 'import { x } from "./mangler";\nexport default () => <p>{x}</p>;',
      "data.ts": "export const x = 1;",
    },
  });

  await expect
    .poll(async () => (await sandboxMessageTypes(page)).includes("failed"))
    .toBe(true);
});

test("an html project inlines the stylesheet and script it names", async ({ page }) => {
  await page.goto("/login");

  const stage = await mountArtifact(page, {
    language: "html",
    entry: "index.html",
    files: {
      "index.html": [
        "<!doctype html><html><head>",
        '<link rel="stylesheet" href="styles.css">',
        '</head><body><p id="out">Side</p><script src="main.js"></script></body></html>',
      ].join("\n"),
      "styles.css": "#out { color: rgb(0, 128, 128) }",
      "main.js": 'document.getElementById("out").textContent = "Kørt";',
    },
  });

  await expect(stage.locator("#out")).toHaveText("Kørt");
  await expect(stage.locator("#out")).toHaveCSS("color", "rgb(0, 128, 128)");
});
