import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, type Page, test } from "@playwright/test";
import * as m from "../src/lib/paraglide/messages";
import { E2E_DATABASE_PATH, E2E_PEPPER, E2E_STORAGE_PATH } from "../playwright.config";
import { ARTIFACT_MARKER } from "./support/stub-gateway";

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

/** Ask the stub for an artifact and wait until the answer has landed. */
async function askForArtifact(page: Page): Promise<void> {
  await page.getByRole("button", { name: m.chat_new_conversation() }).first().click();
  await page.getByRole("textbox", { name: m.chat_composer_label() }).fill(
    `${ARTIFACT_MARKER} lav en klikker`,
  );
  await page.getByRole("button", { name: m.chat_send() }).click();

  await expect(page.getByRole("button", { name: /Build \(1\)|Byg \(1\)/ })).toBeVisible({
    timeout: 20_000,
  });
}

test("a student builds an artifact, edits it, and the edit travels back", async ({ page }) => {
  test.setTimeout(120_000);
  const { code } = await provisionStudent();

  await signIn(page, code);
  await askForArtifact(page);

  // The Build entry point, prominent rather than an obscure toggle (§13).
  await page.getByRole("button", { name: /Build \(1\)|Byg \(1\)/ }).click();

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
  await page.getByRole("textbox", { name: m.chat_composer_label() }).fill("Jeg ødelagde den");
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

  await ownerPage.getByRole("button", { name: /Build \(1\)|Byg \(1\)/ }).click();
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
