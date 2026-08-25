import { describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-svelte";
import * as m from "$lib/paraglide/messages";
import { type ArtifactView, ArtifactWorkspace } from "$lib/state/artifacts.svelte";
import ArtifactPanel from "./ArtifactPanel.svelte";

/**
 * The artifact panel's interaction logic (plan 4.3, PRD §13, §20, §22).
 *
 * What is under test is the panel's own behaviour — what a keystroke does, what
 * a commit point does, what the layout controls do — not the sandbox, which has
 * its own end-to-end suite on a real second origin (§14).
 *
 * `about:blank` stands in for the sandbox origin: a component test has no second
 * origin to serve, and the frame's contents are not what these assertions are
 * about.
 */

const SANDBOX = "about:blank";

function artifact(overrides: Partial<ArtifactView> = {}): ArtifactView {
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
      ...overrides.latest,
    },
    ...overrides,
  };
}

function openWorkspace(items: ArtifactView[] = [artifact()]): ArtifactWorkspace {
  const workspace = new ArtifactWorkspace();
  workspace.items = items;
  workspace.toggle();
  return workspace;
}

describe("ArtifactPanel", () => {
  it("stays out of the way until the Build entry point opens it", async () => {
    const workspace = new ArtifactWorkspace();
    workspace.items = [artifact()];

    render(ArtifactPanel, { workspace, sandboxOrigin: SANDBOX });

    await expect.element(page.getByText("Klikkeren")).not.toBeInTheDocument();
  });

  it("opens on nothing built yet and says what to ask for", async () => {
    const workspace = new ArtifactWorkspace();
    workspace.toggle();

    render(ArtifactPanel, { workspace, sandboxOrigin: SANDBOX });

    // "A prominent Build entry point makes artifact work discoverable rather
    // than an obscure toggle" — so it opens with nothing built (§13).
    await expect.element(page.getByText(m.artifact_empty_heading())).toBeVisible();
  });

  it("shows the artifact's own name and the three views", async () => {
    render(ArtifactPanel, { workspace: openWorkspace(), sandboxOrigin: SANDBOX });

    await expect.element(page.getByText("Klikkeren")).toBeVisible();
    await expect.element(page.getByRole("tab", { name: m.artifact_tab_preview() })).toBeVisible();
    await expect.element(page.getByRole("tab", { name: m.artifact_tab_code() })).toBeVisible();
    await expect.element(page.getByRole("tab", { name: m.artifact_tab_history() })).toBeVisible();
  });

  it("names an untitled artifact by its language rather than inventing one", async () => {
    const workspace = openWorkspace([{ ...artifact(), title: null }]);

    render(ArtifactPanel, { workspace, sandboxOrigin: SANDBOX });

    await expect.element(page.getByText(m.artifact_untitled({ language: "html" }))).toBeVisible();
  });

  it("keeps the preview frame mounted while the source is being read", async () => {
    const workspace = openWorkspace();
    render(ArtifactPanel, { workspace, sandboxOrigin: SANDBOX });

    await page.getByRole("tab", { name: m.artifact_tab_code() }).click();

    // Reloading the artifact because a pupil looked at its source would throw
    // away whatever state it had built up (§13).
    expect(document.querySelectorAll("iframe")).toHaveLength(1);
  });

  it("does not compile on a keystroke", async () => {
    const workspace = openWorkspace();
    render(ArtifactPanel, { workspace, sandboxOrigin: SANDBOX });

    workspace.edit("<button>Min knap</button>");

    // "Compilation is triggered by an explicit Run action or a heavily debounced
    // idle, never per keystroke" (§13) — so the running source has not moved.
    expect(workspace.running).toBe("<button>Klik</button>");
    await expect.element(page.getByText(m.artifact_status_unsaved())).toBeVisible();
  });

  it("runs and stores the edit when Run is pressed", async () => {
    const workspace = openWorkspace();
    const fetched = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "version-2",
          revision: 2,
          source: "<button>Min knap</button>",
          authoredBy: "student",
          createdAt: new Date(1).toISOString(),
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      ),
    );

    try {
      render(ArtifactPanel, { workspace, sandboxOrigin: SANDBOX });
      workspace.edit("<button>Min knap</button>");

      await page.getByRole("button", { name: m.artifact_run() }).click();

      expect(workspace.running).toBe("<button>Min knap</button>");
      // Local: a version, not a model request (§13).
      expect(fetched).toHaveBeenCalledWith(
        "/api/artifacts/artifact-1/versions",
        expect.objectContaining({ method: "POST" }),
      );
    } finally {
      fetched.mockRestore();
    }
  });

  it("tells the student their edit will travel with the next message", async () => {
    const workspace = openWorkspace([
      { ...artifact(), latest: { ...artifact().latest, authoredBy: "student" } },
    ]);

    render(ArtifactPanel, { workspace, sandboxOrigin: SANDBOX });

    await expect.element(page.getByText(m.artifact_edit_carried())).toBeVisible();
  });

  it("gives the preview the whole panel in fullscreen", async () => {
    const workspace = openWorkspace();
    render(ArtifactPanel, { workspace, sandboxOrigin: SANDBOX });

    await page.getByRole("button", { name: m.artifact_layout_fullscreen() }).click();

    // Fullscreen preview is the primary artifact mode on a 640-pixel screen (§20).
    expect(workspace.layout).toBe("fullscreen");
    await expect
      .element(page.getByRole("tab", { name: m.artifact_tab_code() }))
      .not.toBeInTheDocument();
  });

  it("offers split view as a choice and not as the default", async () => {
    // Split view is offered only where there is room for it: at the target
    // device's width a second column costs more than it shows (§20).
    await page.viewport(1024, 768);

    const workspace = openWorkspace();
    render(ArtifactPanel, { workspace, sandboxOrigin: SANDBOX });

    expect(workspace.layout).toBe("overlay");

    await page.getByRole("button", { name: m.artifact_layout_split() }).click();
    expect(workspace.layout).toBe("split");
  });

  it("gives split view a handle that moves the divider (§20)", async () => {
    await page.viewport(1024, 768);

    const workspace = openWorkspace();
    render(ArtifactPanel, { workspace, sandboxOrigin: SANDBOX });
    await page.getByRole("button", { name: m.artifact_layout_split() }).click();

    const handle = page.getByRole("separator", { name: m.artifact_split_handle() });
    await expect.element(handle).toBeInTheDocument();

    // Keyboard first, because a drag must not be the only way to move it.
    const before = workspace.splitFraction;
    await handle.click();
    await userEvent.keyboard("{ArrowRight}");
    expect(workspace.splitFraction).toBeGreaterThan(before);
  });

  it("never lets the divider drag either side out of existence (§20)", () => {
    const workspace = openWorkspace();

    workspace.setSplitFraction(0);
    expect(workspace.splitFraction).toBe(0.25);

    workspace.setSplitFraction(1);
    expect(workspace.splitFraction).toBe(0.8);
  });

  it("shows a build failure as text", async () => {
    const workspace = openWorkspace();
    render(ArtifactPanel, { workspace, sandboxOrigin: SANDBOX });

    workspace.status = "failed";
    workspace.error = "Line 3: Unexpected <";

    // The compiler's own words, rendered as text and never as markup (§13, §21).
    await expect.element(page.getByText("Line 3: Unexpected <")).toBeVisible();
  });

  it("closes back to the conversation", async () => {
    const workspace = openWorkspace();
    render(ArtifactPanel, { workspace, sandboxOrigin: SANDBOX });

    await page.getByRole("button", { name: m.artifact_close() }).click();

    expect(workspace.visible).toBe(false);
    await expect.element(page.getByText("Klikkeren")).not.toBeInTheDocument();
  });
});
