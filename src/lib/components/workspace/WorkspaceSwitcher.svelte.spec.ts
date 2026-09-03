import { describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-svelte";
import * as m from "$lib/paraglide/messages";
import WorkspaceSwitcher from "./WorkspaceSwitcher.svelte";

/**
 * The workspace switcher (PRD §13, §20, §22).
 *
 * Three positions replacing four two-way toggles, so the assertions are about
 * the pattern's own contract: exactly one is chosen, arrows move between them,
 * and the group is one tab stop rather than three.
 */
describe("WorkspaceSwitcher", () => {
  it("offers the three stages with the current one chosen", async () => {
    render(WorkspaceSwitcher, { stage: "both", axis: "inline", onstage: () => {} });

    await expect
      .element(page.getByRole("radio", { name: m.workspace_stage_chat() }))
      .toHaveAttribute("aria-checked", "false");
    await expect
      .element(page.getByRole("radio", { name: m.workspace_stage_both() }))
      .toHaveAttribute("aria-checked", "true");
    await expect
      .element(page.getByRole("radio", { name: m.workspace_stage_build() }))
      .toHaveAttribute("aria-checked", "false");
  });

  it("reports the stage a pupil picks", async () => {
    const chosen = vi.fn();
    render(WorkspaceSwitcher, { stage: "chat", axis: "inline", onstage: chosen });

    await page.getByRole("radio", { name: m.workspace_stage_build() }).click();

    expect(chosen).toHaveBeenCalledWith("build");
  });

  it("is one tab stop, and the arrows move within it", async () => {
    const chosen = vi.fn();
    render(WorkspaceSwitcher, { stage: "chat", axis: "inline", onstage: chosen });

    // Roving tabindex: only the chosen radio is reachable by Tab, which is what
    // keeps a three-position control from costing three tab stops.
    await expect
      .element(page.getByRole("radio", { name: m.workspace_stage_chat() }))
      .toHaveAttribute("tabindex", "0");
    await expect
      .element(page.getByRole("radio", { name: m.workspace_stage_both() }))
      .toHaveAttribute("tabindex", "-1");

    await page.getByRole("radio", { name: m.workspace_stage_chat() }).click();
    await userEvent.keyboard("{ArrowRight}");

    expect(chosen).toHaveBeenLastCalledWith("both");
  });

  it("counts an arrow from the focused radio, not from a stage that moved", async () => {
    const chosen = vi.fn();
    // The model wrote something while the pupil was reading, so `reveal` has
    // already moved the stage to `both` — but the keyboard never left *Chat*.
    const { rerender } = await render(WorkspaceSwitcher, {
      stage: "chat",
      axis: "inline",
      onstage: chosen,
    });

    await page.getByRole("radio", { name: m.workspace_stage_chat() }).click();
    await rerender({ stage: "both", axis: "inline", onstage: chosen });

    await userEvent.keyboard("{ArrowRight}");

    // Counting from the new stage would land on *Build*, skipping the position
    // the pupil was just moved to and never asked to leave.
    expect(chosen).toHaveBeenLastCalledWith("both");
  });

  it("answers to both arrow pairs, as a radio group does whichever way it lies", async () => {
    const chosen = vi.fn();
    render(WorkspaceSwitcher, { stage: "chat", axis: "inline", onstage: chosen });

    await page.getByRole("radio", { name: m.workspace_stage_chat() }).click();
    await userEvent.keyboard("{ArrowDown}");

    expect(chosen).toHaveBeenLastCalledWith("both");
  });

  it("badges the switcher when something was built that the pupil has not seen", async () => {
    render(WorkspaceSwitcher, {
      stage: "chat",
      axis: "inline",
      unseen: true,
      count: 2,
      onstage: () => {},
    });

    // A live region that is in the document from the start and only changes its
    // text: one created and filled in the same update is not announced, so a
    // pupil who cannot see the dot would learn nothing (§13).
    const announcement = page.getByRole("status");
    await expect.element(announcement).toHaveTextContent(m.artifact_build_unseen());
  });

  it("keeps the announcement region present while there is nothing to announce", async () => {
    render(WorkspaceSwitcher, { stage: "chat", axis: "inline", count: 2, onstage: () => {} });

    await expect.element(page.getByRole("status")).toHaveTextContent("");
  });
});
