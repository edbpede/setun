import { expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-svelte";
import * as m from "$lib/paraglide/messages";
import ArtifactStubCard from "./ArtifactStubCard.svelte";

it("does not label an anonymous runnable fence as a project file", async () => {
  render(ArtifactStubCard, {
    language: "html",
    artifactKey: null,
    path: "src/page.html",
    title: "Page",
    pending: true,
  });
  await expect.element(page.getByText(m.artifact_card_building({ title: "Page" }))).toBeVisible();
  expect(document.body.textContent).not.toContain("src/page.html");
});
