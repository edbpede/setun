import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import * as m from "../src/lib/paraglide/messages";
import { APP_ORIGIN, E2E_DATABASE_PATH, E2E_PEPPER, SANDBOX_ORIGIN } from "../playwright.config";
import { mountArtifact, sandboxMessageTypes } from "./support/artifact-host";

/**
 * The artifact escape suite (plan 4.7, PRD §14, §22).
 *
 * "Automated tests attempt parent DOM access, cookie and storage access,
 * authenticated API calls, external fetches, frame escape, navigation, and popup
 * abuse — and assert that each fails."
 *
 * The probes run from a signed-in application page, with a real session cookie
 * in the browser, because that is the situation the isolation has to hold in. A
 * suite that ran them from a blank page would prove nothing about the cookie it
 * never had.
 */

const run = promisify(execFile);
const CLASSROOM = "E2E escape";

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

/**
 * An artifact that tries every escape §14 names and reports what happened.
 *
 * Each probe returns `true` when the escape *succeeded*; a thrown error, or a
 * falsy return, is the containment working. The report is written into the
 * artifact's own DOM, which Playwright can read across the origin boundary even
 * though nothing on the page can.
 */
function hostileArtifact(appOrigin: string): string {
  return `<!doctype html><html><body><pre id="report">running</pre><script>
const lines = [];
function probe(name, attempt) {
  try { lines.push(name + ":" + (attempt() ? "ALLOWED" : "BLOCKED")); }
  catch (error) { lines.push(name + ":BLOCKED"); }
}
async function probeAsync(name, attempt) {
  try { lines.push(name + ":" + ((await attempt()) ? "ALLOWED" : "BLOCKED")); }
  catch (error) { lines.push(name + ":BLOCKED"); }
}

probe("parent-dom", () => !!parent.document.body);
probe("top-dom", () => !!top.document.body);
probe("top-location-read", () => !!top.location.href);
probe("cookie", () => document.cookie.length > 0);
// The storage probes changed meaning when the shim arrived, and the property
// they assert is unchanged: nothing an artifact writes reaches a real Storage,
// this origin, or the application. What is different is that the write no longer
// *throws* — an opaque origin makes localStorage throw, which killed any game
// that saved a score on the line where it tried. So: the native object is still
// unreachable, and what stands in its place is an in-memory object whose
// contents never leave the sandbox (asserted from the host, below).
probe("native-local-storage", () => localStorage instanceof Storage);
probe("native-session-storage", () => sessionStorage instanceof Storage);
probe("storage-shim", () => {
  localStorage.setItem("score", "12");
  sessionStorage.setItem("turn", "3");
  return localStorage.getItem("score") === "12" && sessionStorage.getItem("turn") === "3";
});
// Navigation is attempted, not probed: a browser that refuses it logs and moves
// on rather than throwing, so the assertion that it failed is that nothing moved
// — checked from outside, where the URLs are readable.
try { top.location.href = "https://escape.invalid/"; } catch (error) {}
try { parent.location.href = "https://escape.invalid/"; } catch (error) {}
try { top.location.replace("https://escape.invalid/"); } catch (error) {}
probe("popup", () => window.open("https://escape.invalid/") !== null);

(async () => {
  // The constructor may return before the policy is applied, so the verdict is
  // whichever event arrives: an open socket is an escape, an error is not.
  await probeAsync("websocket", async () => {
    return await new Promise((resolve) => {
      let socket;
      try { socket = new WebSocket("wss://escape.invalid/"); } catch (error) { resolve(false); return; }
      socket.onopen = () => resolve(true);
      socket.onerror = () => resolve(false);
      socket.onclose = () => resolve(false);
      setTimeout(() => resolve(false), 3000);
    });
  });
  await probeAsync("external-fetch", async () => {
    const response = await fetch("https://escape.invalid/", { mode: "no-cors" });
    return !!response;
  });
  await probeAsync("authenticated-api", async () => {
    const response = await fetch(${JSON.stringify(`${appOrigin}/api/conversations`)}, {
      credentials: "include",
    });
    return response.status !== 0;
  });
  await probeAsync("xhr-api", async () => {
    return await new Promise((resolve) => {
      const request = new XMLHttpRequest();
      request.onload = () => resolve(true);
      request.onerror = () => resolve(false);
      request.open("GET", ${JSON.stringify(`${appOrigin}/api/conversations`)});
      request.withCredentials = true;
      request.send();
    });
  });

  document.getElementById("report").textContent = lines.join("\\n") + "\\nDONE";
})();
</script></body></html>`;
}

test("every escape an artifact can attempt fails", async ({ page }) => {
  const { code } = await provisionStudent();

  // Signed in, so the browser holds a real session cookie for this origin.
  await page.goto("/login");
  await page.getByLabel(m.login_code_label()).fill(code);
  await page.getByRole("button", { name: m.login_submit() }).click();
  await expect(page).toHaveURL(/\/chat/);

  const stage = await mountArtifact(page, {
    language: "html",
    source: hostileArtifact(APP_ORIGIN),
  });

  const report = stage.locator("#report");
  await expect(report).toContainText("DONE", { timeout: 20_000 });

  const results = (await report.textContent()) ?? "";

  for (const probe of [
    // Parent DOM and frame escape (§14).
    "parent-dom",
    "top-dom",
    "top-location-read",
    // Cookie and storage access (§14).
    "cookie",
    "native-local-storage",
    "native-session-storage",
    // Popup abuse (§14).
    "popup",
    // Outbound network: external, authenticated, and by every transport (§14).
    "websocket",
    "external-fetch",
    "authenticated-api",
    "xhr-api",
  ]) {
    expect(results, `${probe} must be blocked`).toContain(`${probe}:BLOCKED`);
  }

  // Navigation failed, which is visible as nothing having moved: the hosting
  // page, the runner frame, and the artifact's own document are all where they
  // were, and no popup was opened (§14).
  await expect(page).toHaveURL(/\/chat/);
  expect(page.context().pages()).toHaveLength(1);
  await expect(report).toContainText("DONE");

  const frames = page.frames().map((frame) => frame.url());
  expect(frames.some((url) => url.includes("escape.invalid"))).toBe(false);

  // The shim is real storage as far as the artifact is concerned — a game that
  // saves a score works — and it is nobody else's storage (§13).
  expect(results, "the in-memory shim stands in for the native object").toContain(
    "storage-shim:ALLOWED",
  );

  // And its contents stop at the runner: no snapshot is posted to the
  // application, and the application origin's own storage is untouched (§13, §14).
  const posted = await sandboxMessageTypes(page);
  expect(posted).not.toContain("storage");

  const appStorage = await page.evaluate(() => ({
    score: localStorage.getItem("score"),
    turn: sessionStorage.getItem("turn"),
  }));
  expect(appStorage).toEqual({ score: null, turn: null });
});

test("the sandbox origin serves the isolating policy", async ({ request }) => {
  // The isolation is the origin's own headers, not something the application
  // asks for per request — so it is asserted where it is served (§14, §21).
  const response = await request.get(`${SANDBOX_ORIGIN}/`);

  const policy = response.headers()["content-security-policy"] ?? "";

  expect(policy).toContain("default-src 'none'");
  expect(policy).toContain("form-action 'none'");
  expect(policy).toContain("base-uri 'none'");
  // Outbound network reaches this origin's own runtimes and nothing else.
  expect(policy).not.toContain("connect-src *");
  expect(response.headers()["x-content-type-options"]).toBe("nosniff");
});

test("the sandbox origin serves nothing of the application", async ({ request }) => {
  // "It proxies nothing, so generated code has no route back into the
  // application from here" (§6, §14).
  for (const path of ["/api/conversations", "/chat", "/login"]) {
    const response = await request.get(`${SANDBOX_ORIGIN}${path}`, { failOnStatusCode: false });
    expect(response.status()).toBe(404);
  }
});
