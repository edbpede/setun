import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, type Page, test } from "@playwright/test";
import * as m from "../src/lib/paraglide/messages";
import { E2E_DATABASE_PATH, E2E_PEPPER, E2E_STORAGE_PATH } from "../playwright.config";
import {
  ARTIFACT_MARKER,
  ARTIFACT_REVISION_MARKER,
  ARTIFACT_SECOND_MARKER,
} from "./support/stub-gateway";
import { clearLoginWindow } from "./support/login-window";

/**
 * The student build flow, end to end (plan 4.3–4.6; PRD §13, §22).
 *
 * The Phase 4 exit criterion: a student asks for an interactive page, it renders
 * in the sandboxed frame, they edit it in CodeMirror, see a diff of what the
 * model wrote, and their edit travels back on the next message — with the
 * creations gallery holding what they made afterwards.
 */

const run = promisify(execFile);
const CLASSROOM = "E2E build";

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

async function seedImage(label: string): Promise<{ id: string; prompt: string }> {
  const { stdout } = await run("bun", ["run", "e2e/support/seed-image.ts"], {
    env: {
      ...process.env,
      SETUN_DATABASE_PATH: E2E_DATABASE_PATH,
      SETUN_STORAGE_PATH: E2E_STORAGE_PATH,
      SETUN_E2E_STUDENT_LABEL: label,
    },
  });

  return JSON.parse(stdout.trim());
}

async function signIn(page: Page, code: string): Promise<void> {
  await page.goto("/login");
  await page.getByLabel(m.login_code_label()).fill(code);
  await page.getByRole("button", { name: m.login_submit() }).click();
  await expect(page).toHaveURL(/\/chat/);
}

/**
 * Send a message and wait until the Build button reports `count` artifacts.
 *
 * The panel is closed first when it is open: it is an overlay over the whole
 * conversation, so it covers the composer — which is the point on a 640-pixel
 * screen, and means a pupil returns to the chat by closing it (§20).
 */
async function ask(page: Page, text: string, count: number): Promise<void> {
  const close = page.getByRole("button", { name: m.artifact_close() });
  if (await close.isVisible()) await close.click();

  await page.getByRole("textbox", { name: m.chat_composer_label() }).fill(text);
  await page.getByRole("button", { name: m.chat_send() }).click();

  await expect(
    page.getByRole("button", { name: new RegExp(`Build \\(${count}\\)|Byg \\(${count}\\)`) }),
  ).toBeVisible({ timeout: 20_000 });
}

/** Ask the stub for an artifact and wait until the answer has landed. */
async function askForArtifact(page: Page): Promise<void> {
  await page.getByRole("button", { name: m.chat_new_conversation() }).first().click();
  // Wait for the conversation to exist before typing into the composer. The
  // composer is present from the first visit now — the conversation is minted on
  // the first send — so its appearance is no longer the implicit wait it used to
  // be, and a draft typed before this navigation lands is discarded by it.
  await expect(page).toHaveURL(/\?c=/);
  await ask(page, `${ARTIFACT_MARKER} lav en klikker`, 1);
}

/**
 * Appendix A caps one IP at 30 login attempts per 15 minutes, and every worker
 * here is loopback. Cleared per test so the suites do not fail each other's
 * sign-ins; the limiter itself is asserted in `bun test` (§7, §22).
 */
test.beforeEach(clearLoginWindow);

test("a student builds an artifact, edits it, and the edit travels back", async ({ page }) => {
  test.setTimeout(120_000);
  const { code } = await provisionStudent();

  await signIn(page, code);
  await askForArtifact(page);

  // The panel opens on the model's write rather than waiting to be found: the
  // Build entry point is still there, but the pupil does not have to look (§13).
  await expect(page.getByRole("tab", { name: m.artifact_tab_preview() })).toBeVisible({
    timeout: 20_000,
  });

  // Tier 0: it renders in the sandboxed frame with no build step (§13, §14).
  const stage = page
    .frameLocator('iframe[title="' + m.artifact_frame_title() + '"]')
    .frameLocator("#stage");
  await expect(stage.locator("#knap")).toHaveText("Klik her", { timeout: 20_000 });

  // The source, in CodeMirror.
  await page.getByRole("tab", { name: m.artifact_tab_code() }).click();
  const editor = page.locator(".cm-content");
  await expect(editor).toBeVisible({ timeout: 20_000 });

  await editor.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type('<p id="knap">Min knap</p>');

  // An explicit Run is a commit point: it compiles and it stores a revision (§13).
  await page.getByRole("button", { name: m.artifact_run() }).click();
  await expect(page.getByText(m.artifact_edit_carried())).toBeVisible({ timeout: 20_000 });

  // The edit is a version of its own; the diff has both sides (§13).
  await page.getByRole("tab", { name: m.artifact_tab_history() }).click();
  await expect(
    page.getByRole("button", { name: m.artifact_version_label({ revision: 2 }) }),
  ).toBeVisible();
  await expect(page.getByText(m.artifact_version_by_student()).first()).toBeVisible();
  await expect(page.getByText(m.artifact_version_by_model()).first()).toBeVisible();

  const artifactId = await page
    .locator("[data-artifact-id]")
    .first()
    .getAttribute("data-artifact-id");

  // Asserted at the API level too, not only in the interface (§22). Read before
  // the next turn, which will have the model writing a revision of its own.
  const stored = await page.request.get(`/api/artifacts/${artifactId}`);
  expect(stored.status()).toBe(200);

  const body = await stored.json();
  expect(body.versions).toHaveLength(2);
  expect(body.versions[0].authoredBy).toBe("model");
  expect(body.versions[1].authoredBy).toBe("student");
  expect(body.versions[1].source).toContain("Min knap");

  await page.getByRole("button", { name: m.artifact_close() }).click();

  // The next message carries the current source, marked as the student's (§13).
  // It asks for an artifact too, so the model writes a revision of its own —
  // which is what makes "delivered once" observable in the next assertion.
  await page
    .getByRole("textbox", { name: m.chat_composer_label() })
    .fill(`Jeg ødelagde den — ${ARTIFACT_MARKER}`);
  await page.getByRole("button", { name: m.chat_send() }).click();

  await expect(page.getByText(/Your edited version of|Din rettede version af/)).toBeVisible({
    timeout: 20_000,
  });

  // And it travelled once, not on every later turn (§13): the edit is delivered,
  // so the model's own next revision is what the artifact now holds.
  const after = await (await page.request.get(`/api/artifacts/${artifactId}`)).json();
  expect(after.versions.at(-1).authoredBy).toBe("model");
});

test("the creations gallery holds what the student made", async ({ page }) => {
  test.setTimeout(120_000);
  const { label, code } = await provisionStudent();
  const image = await seedImage(label);

  await signIn(page, code);
  await askForArtifact(page);

  // The panel auto-opened over the conversation; the drawer is behind it.
  await page.getByRole("button", { name: m.artifact_close() }).click();
  await page.getByRole("button", { name: m.chat_conversations() }).click();
  await page.getByRole("link", { name: m.creations_link() }).click();
  await expect(page).toHaveURL(/\/creations/);

  // Both kinds of creation, in one portfolio (§13, §16).
  await expect(page.getByText("Klikkeren")).toBeVisible();
  await expect(page.getByAltText(m.creations_image_alt({ prompt: image.prompt }))).toBeVisible();

  // Students delete their own creations (§16).
  await page.getByRole("button", { name: m.artifact_delete() }).first().click();
  await expect(page.getByText("Klikkeren")).toHaveCount(0);
});

test("a student cannot reach another student's artifact", async ({ browser }) => {
  test.setTimeout(120_000);
  const [owner, intruder] = await Promise.all([provisionStudent(), provisionStudent()]);

  const ownerContext = await browser.newContext();
  const ownerPage = await ownerContext.newPage();
  await signIn(ownerPage, owner.code);
  await askForArtifact(ownerPage);

  const target = await ownerPage
    .locator("[data-artifact-id]")
    .first()
    .getAttribute("data-artifact-id");

  expect(target ?? "").not.toBe("");

  const intruderContext = await browser.newContext();
  const intruderPage = await intruderContext.newPage();
  await signIn(intruderPage, intruder.code);

  // Absent, not forbidden: there is nothing to probe (§21).
  const read = await intruderPage.request.get(`/api/artifacts/${target}`);
  expect(read.status()).toBe(404);

  const write = await intruderPage.request.post(`/api/artifacts/${target}/versions`, {
    data: { source: "<p>stjålet</p>" },
  });
  expect(write.status()).toBe(404);

  // And nothing of the owner's shows in the intruder's own gallery (§16, §21).
  await intruderPage.goto("/creations");
  await expect(intruderPage.getByText("Klikkeren")).toHaveCount(0);

  await ownerContext.close();
  await intruderContext.close();
});

test("the artifact API refuses an unauthenticated caller", async ({ request }) => {
  const read = await request.get(`/api/artifacts/${crypto.randomUUID()}`);
  expect(read.status()).toBe(401);

  const write = await request.post(`/api/artifacts/${crypto.randomUUID()}/versions`, {
    data: { source: "<p>x</p>" },
  });
  expect(write.status()).toBe(401);
});

test("a second turn revises the same artifact rather than replacing it", async ({ page }) => {
  test.setTimeout(120_000);
  const { code } = await provisionStudent();

  await signIn(page, code);
  await askForArtifact(page);

  // The failure this replaces: the follow-up produced a fragment, which became
  // revision 2 of the page — so the page disappeared and the quiz did not work
  // either. Under one id the answer is a complete document (§13).
  await ask(page, `${ARTIFACT_REVISION_MARKER} tilføj en quiz om mig`, 1);

  // The panel opens on the model's write and follows it, so the quiz is on
  // screen without the pupil going looking for it (§13, §20).
  const stage = page
    .frameLocator(`iframe[title="${m.artifact_frame_title()}"]`)
    .frameLocator("#stage");
  await expect(stage.locator("#quiz")).toBeVisible({ timeout: 20_000 });
  // And the button the first turn made is still there.
  await expect(stage.locator("#knap")).toHaveText("Klik her");

  const artifactId = await page
    .locator("[data-artifact-id]")
    .first()
    .getAttribute("data-artifact-id");

  const stored = await (await page.request.get(`/api/artifacts/${artifactId}`)).json();
  expect(stored.key).toBe("klikkeren");
  expect(stored.versions).toHaveLength(2);
  expect(stored.versions[1].authoredBy).toBe("model");
  expect(stored.versions[1].source).toContain("quiz");

  // A different id is a different thing, not a revision of this one.
  await ask(page, `${ARTIFACT_SECOND_MARKER} lav et logo`, 2);
});

test("the transcript card opens what the model built", async ({ page }) => {
  test.setTimeout(120_000);
  const { code } = await provisionStudent();

  await signIn(page, code);
  await askForArtifact(page);

  // The panel auto-opened on the write; close it, so the card is what reopens it.
  await page.getByRole("button", { name: m.artifact_close() }).click();

  // The transcript shows what was built, not the markup it was written as (§13).
  await expect(page.getByText("<!doctype html>")).toHaveCount(0);
  await page.getByRole("button", { name: m.artifact_card_label({ title: "Klikkeren" }) }).click();

  const stage = page
    .frameLocator(`iframe[title="${m.artifact_frame_title()}"]`)
    .frameLocator("#stage");
  await expect(stage.locator("#knap")).toHaveText("Klik her", { timeout: 20_000 });
});

test("a run's outcome is recorded against the version it ran", async ({ page }) => {
  test.setTimeout(120_000);
  const { code } = await provisionStudent();

  await signIn(page, code);
  await askForArtifact(page);

  const artifactId = await page
    .locator("[data-artifact-id]")
    .first()
    .getAttribute("data-artifact-id");
  const read = async () =>
    (await (await page.request.get(`/api/artifacts/${artifactId}`)).json()).versions[0];

  // The panel is open and running the artifact, and reports that outcome itself
  // — which is the feature under test, and the browser is the only party that
  // knows (§13). Wait for it before writing anything: the report is a PATCH like
  // any other, and racing it is how this test read back somebody else's answer.
  await expect.poll(async () => (await read()).buildStatus, { timeout: 30_000 }).toBe("ok");

  // Closed, so nothing further reports while the failure below is written.
  await page.getByRole("button", { name: m.artifact_close() }).click();

  const versionId = (await read()).id;
  const patched = await page.request.patch(
    `/api/artifacts/${artifactId}/versions/${versionId}`,
    { data: { buildStatus: "failed", buildMessage: "SyntaxError" } },
  );
  expect(patched.status()).toBe(200);

  const after = await read();
  expect(after.buildStatus).toBe("failed");
  expect(after.buildMessage).toBe("SyntaxError");

  // A status the schema does not name is refused before it reaches the database.
  const invalid = await page.request.patch(
    `/api/artifacts/${artifactId}/versions/${versionId}`,
    { data: { buildStatus: "exploded" } },
  );
  expect(invalid.status()).toBe(400);
});

test("a build outcome cannot be written to somebody else's artifact", async ({ browser }) => {
  test.setTimeout(120_000);
  const [owner, intruder] = await Promise.all([provisionStudent(), provisionStudent()]);

  const ownerContext = await browser.newContext();
  const ownerPage = await ownerContext.newPage();
  await signIn(ownerPage, owner.code);
  await askForArtifact(ownerPage);

  const target = await ownerPage
    .locator("[data-artifact-id]")
    .first()
    .getAttribute("data-artifact-id");
  const stored = await (await ownerPage.request.get(`/api/artifacts/${target}`)).json();
  const versionId = stored.versions[0].id;

  const intruderContext = await browser.newContext();
  const intruderPage = await intruderContext.newPage();
  await signIn(intruderPage, intruder.code);

  // Absent, not forbidden: there is nothing to probe (§21).
  const write = await intruderPage.request.patch(
    `/api/artifacts/${target}/versions/${versionId}`,
    { data: { buildStatus: "failed", buildMessage: "hacked" } },
  );
  expect(write.status()).toBe(404);

  const unauthenticated = await browser.newContext();
  const anonymous = await unauthenticated.newPage();
  const refused = await anonymous.request.patch(
    `/api/artifacts/${target}/versions/${versionId}`,
    { data: { buildStatus: "failed" } },
  );
  expect(refused.status()).toBe(401);

  // And nothing of the intruder's was recorded. The status itself is the owner's
  // own panel reporting its run, so the message is what proves it: only the
  // refused write could have put that word there.
  const after = await (await ownerPage.request.get(`/api/artifacts/${target}`)).json();
  expect(after.versions[0].buildMessage).not.toBe("hacked");

  await ownerContext.close();
  await intruderContext.close();
  await unauthenticated.close();
});
