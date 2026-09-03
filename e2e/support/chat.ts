import { expect, type Page } from "@playwright/test";
import * as m from "../../src/lib/paraglide/messages";

/**
 * Driving the student workspace from a suite (PRD §10, §13, §20).
 *
 * Starting a thread lives in the drawer with the rest of what a pupil does
 * between lessons rather than during one, so every suite that needs a fresh
 * conversation opens the drawer first. One helper, so a change to where that
 * control lives is one edit rather than five.
 */

/** Paraglide's own option shape, so a suite can drive a Danish classroom. */
type LocaleOptions = { locale?: "en" | "da" };

export async function openDrawer(page: Page, options: LocaleOptions = {}): Promise<void> {
  await page.getByRole("button", { name: m.chat_conversations({}, options) }).click();
}

/** Start a conversation and wait until the page is on it. */
export async function startConversation(page: Page, options: LocaleOptions = {}): Promise<void> {
  await openDrawer(page, options);
  await page.getByRole("button", { name: m.chat_new_conversation({}, options) }).click();

  // The composer is present from the first visit — the conversation is minted on
  // the first send — so its appearance is not the implicit wait it once was.
  await expect(page).toHaveURL(/\?c=/);
}
