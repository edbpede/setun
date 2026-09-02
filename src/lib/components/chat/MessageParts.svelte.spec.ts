import { describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-svelte";
import * as m from "$lib/paraglide/messages";
import type { MessagePart } from "$lib/server/db/schema";
import type { MessageArtifactRef } from "$lib/state/conversation.svelte";
import MessageParts from "./MessageParts.svelte";

/**
 * An artifact in the transcript is a card, not a wall of markup (PRD §13, §20).
 *
 * The pupil's route from "here is the page" to the page itself is one tap. What
 * matters as much is the fallback: the cards come from the database and the
 * blocks from the text, and when the two disagree the fence renders as it was
 * written rather than a card naming the wrong thing.
 */

const PROSE = ["Her er siden:", "```html id=side", "<p>hi</p>", "```", "Prøv den."].join("\n");

function text(value: string): MessagePart[] {
  return [{ type: "text", text: value }];
}

function ref(overrides: Partial<MessageArtifactRef> = {}): MessageArtifactRef {
  return {
    artifactId: "artifact-1",
    versionId: "version-3",
    revision: 3,
    key: "side",
    language: "html",
    title: "Min side",
    buildStatus: null,
    ...overrides,
  };
}

describe("MessageParts artifact cards", () => {
  it("shows what was built, with its identity in the mono line", async () => {
    render(MessageParts, { parts: text(PROSE), artifacts: [ref()] });

    await expect.element(page.getByText("Min side")).toBeVisible();
    await expect.element(page.getByText("id=side · html · v3")).toBeVisible();
    // The prose around it is still prose.
    await expect.element(page.getByText("Her er siden:")).toBeVisible();
    await expect.element(page.getByText("Prøv den.")).toBeVisible();
    // And the markup itself is not in the transcript.
    await expect.element(page.getByText("<p>hi</p>")).not.toBeInTheDocument();
  });

  it("opens the artifact when the card is used", async () => {
    const opened = vi.fn();
    render(MessageParts, { parts: text(PROSE), artifacts: [ref()], onopenartifact: opened });

    await page.getByRole("button", { name: m.artifact_card_label({ title: "Min side" }) }).click();

    expect(opened).toHaveBeenCalledWith("artifact-1");
  });

  it("names an untitled artifact by its language rather than inventing one", async () => {
    render(MessageParts, { parts: text(PROSE), artifacts: [ref({ title: null })] });

    await expect.element(page.getByText(m.artifact_untitled({ language: "html" }))).toBeVisible();
  });

  it("falls back to the fence when the message records no artifacts", async () => {
    render(MessageParts, { parts: text(PROSE) });

    // Never a card naming something the database does not have.
    await expect.element(page.getByText("<p>hi</p>")).toBeVisible();
    await expect.element(page.getByText("id=side · html · v3")).not.toBeInTheDocument();
  });

  it("falls back to the fence when the refs and the blocks disagree", async () => {
    // Two blocks, one ref: something recorded a revision the text does not show,
    // and pairing them by position would name the wrong one.
    const two = "```html id=side\n<p>en</p>\n```\n```svg id=logo\n<svg/>\n```";
    render(MessageParts, { parts: text(two), artifacts: [ref()] });

    await expect.element(page.getByText("<p>en</p>")).toBeVisible();
  });

  it("falls back when a ref names a different language than the block", async () => {
    render(MessageParts, { parts: text(PROSE), artifacts: [ref({ language: "svg" })] });

    await expect.element(page.getByText("<p>hi</p>")).toBeVisible();
  });

  it("shows the build state on the card", async () => {
    render(MessageParts, { parts: text(PROSE), artifacts: [ref({ buildStatus: "failed" })] });

    await expect.element(page.getByRole("img", { name: m.artifact_status_failed() })).toBeVisible();
  });

  it("leaves streaming text plain, because parsing every delta drops frames", async () => {
    render(MessageParts, { parts: text(PROSE), artifacts: [ref()], streaming: true });

    // §20: markdown and cards wait until the turn settles.
    await expect.element(page.getByText("<p>hi</p>")).toBeVisible();
  });

  it("never parses the pupil's own words", async () => {
    render(MessageParts, { parts: text(PROSE), artifacts: [ref()], plain: true });

    await expect.element(page.getByText("<p>hi</p>")).toBeVisible();
  });
});
