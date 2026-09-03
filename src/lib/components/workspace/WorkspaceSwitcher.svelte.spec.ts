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

  it("badges the switcher when something was built that the pupil has not seen", async () => {
    render(WorkspaceSwitcher, {
      stage: "chat",
      axis: "inline",
      unseen: true,
      count: 2,
      onstage: () => {},
    });

    await expect.element(page.getByText(m.artifact_build_unseen())).toBeInTheDocument();
  });
});
