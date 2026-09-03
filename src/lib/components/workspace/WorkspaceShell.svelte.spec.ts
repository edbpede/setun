import { createRawSnippet } from "svelte";
import { describe, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-svelte";
import * as m from "$lib/paraglide/messages";
import { type ArtifactView, ArtifactWorkspace } from "$lib/state/artifacts.svelte";
import WorkspaceShell from "./WorkspaceShell.svelte";

/**
 * The workspace geometry (PRD §13, §20, §22).
 *
 * What is under test is which surfaces are in the document at each stage, and
 * that the divider is reachable without a pointer — not how wide anything is,
 * which is CSS and belongs to a screen rather than an assertion.
 */

const chat = createRawSnippet(() => ({
  render: () => `<div data-testid="chat">Samtalen</div>`,
}));
const build = createRawSnippet(() => ({
  render: () => `<div data-testid="build">Byggeriet</div>`,
}));

function artifact(): ArtifactView {
  return {
    id: "artifact-1",
    language: "html",
    title: "Klikkeren",
    latest: {
      id: "version-1",
      revision: 1,
      source: "<button>Klik</button>",
      authoredBy: "model",
      createdAt: new Date(0).toISOString(),
    },
  };
}

function workspaceWith(stage: "chat" | "both" | "build"): ArtifactWorkspace {
  const workspace = new ArtifactWorkspace();
  workspace.items = [artifact()];
  workspace.select("artifact-1");
  workspace.setStage(stage);
  return workspace;
}

describe("WorkspaceShell", () => {
  it("shows the conversation alone, with no divider to drag", async () => {
    render(WorkspaceShell, { workspace: workspaceWith("chat"), axis: "inline", chat, build });

    await expect.element(page.getByTestId("chat")).toBeVisible();
    await expect.element(page.getByTestId("build")).not.toBeVisible();
    await expect
      .element(page.getByRole("separator", { name: m.artifact_split_handle() }))
      .not.toBeInTheDocument();
  });

  it("keeps the running artifact in the document while the conversation is read", async () => {
    render(WorkspaceShell, { workspace: workspaceWith("chat"), axis: "inline", chat, build });

    // Hidden, not unmounted: a game that saved a score must still have it when
    // the pupil comes back from reading the answer (§13).
    await expect.element(page.getByTestId("build")).toBeInTheDocument();
  });

  it("puts both surfaces on screen with a divider between them", async () => {
    render(WorkspaceShell, { workspace: workspaceWith("both"), axis: "inline", chat, build });

    await expect.element(page.getByTestId("chat")).toBeVisible();
    await expect.element(page.getByTestId("build")).toBeVisible();

    const handle = page.getByRole("separator", { name: m.artifact_split_handle() });
    await expect.element(handle).toBeVisible();
    await expect.element(handle).toHaveAttribute("aria-orientation", "vertical");
  });

  it("stacks the two surfaces where there is no room for a second column", async () => {
    render(WorkspaceShell, { workspace: workspaceWith("both"), axis: "block", chat, build });

    // The same divider, turned: a vertical rule on a screen that stacks its
    // panes is a small lie about what dragging it will do (§20).
    await expect
      .element(page.getByRole("separator", { name: m.artifact_split_handle() }))
      .toHaveAttribute("aria-orientation", "horizontal");
  });

  it("gives the build surface the whole screen", async () => {
    render(WorkspaceShell, { workspace: workspaceWith("build"), axis: "inline", chat, build });

    await expect.element(page.getByTestId("build")).toBeVisible();
    await expect.element(page.getByTestId("chat")).not.toBeVisible();
  });

  it("moves the divider from the keyboard (§20)", async () => {
    const workspace = workspaceWith("both");
    render(WorkspaceShell, { workspace, axis: "inline", chat, build });

    const before = workspace.fraction;
    await page.getByRole("separator", { name: m.artifact_split_handle() }).click();
    await userEvent.keyboard("{ArrowRight}");

    // A drag must never be the only way to reach a layout.
    expect(workspace.fraction).toBeGreaterThan(before);

    await userEvent.keyboard("{Home}");
    expect(workspace.fraction).toBe(0.3);
  });
});
