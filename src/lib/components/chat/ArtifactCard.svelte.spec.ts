import { describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-svelte";
import * as m from "$lib/paraglide/messages";
import type { MessageArtifactRef } from "$lib/state/conversation.svelte";
import ArtifactCard from "./ArtifactCard.svelte";

/**
 * The artifact card in the transcript (PRD §13, §20, §22).
 *
 * The card is the route from "here is the page" to the page. It is one control
 * rather than a label with a button parked on its end, and it says when it is
 * the thing currently on screen — which is what turns a column of similar cards
 * into a way of moving between builds.
 */

function ref(overrides: Partial<MessageArtifactRef> = {}): MessageArtifactRef {
  return {
    artifactId: "artifact-1",
    versionId: "version-1",
    revision: 2,
    key: "klikkeren",
    language: "html",
    title: "Klikkeren",
    buildStatus: "ok",
    ...overrides,
  };
}

describe("ArtifactCard", () => {
  it("names what was built and the identity the model reuses", async () => {
    render(ArtifactCard, { artifact: ref() });

    await expect
      .element(page.getByRole("button", { name: m.artifact_card_label({ title: "Klikkeren" }) }))
      .toBeVisible();
    // Identity is always the mono face, so code-things read as code-things.
    await expect.element(page.getByText("id=klikkeren · html · v2")).toBeVisible();
  });

  it("opens the artifact from the whole card", async () => {
    const opened = vi.fn();
    render(ArtifactCard, { artifact: ref(), onopen: opened });

    await page.getByRole("button", { name: m.artifact_card_label({ title: "Klikkeren" }) }).click();

    expect(opened).toHaveBeenCalledWith("artifact-1");
  });

  it("says when it is the one already on screen", async () => {
    render(ArtifactCard, { artifact: ref(), active: true });

    await expect.element(page.getByText(m.artifact_showing())).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: m.artifact_card_label({ title: "Klikkeren" }) }))
      .toHaveAttribute("aria-current", "true");
  });

  it("names an untitled artifact by its language rather than inventing one", async () => {
    render(ArtifactCard, { artifact: ref({ title: null }) });

    const title = m.artifact_untitled({ language: "html" });
    await expect
      .element(page.getByRole("button", { name: m.artifact_card_label({ title }) }))
      .toBeVisible();
  });
});
