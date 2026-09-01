import { defaults } from "sveltekit-superforms";
import { valibot } from "sveltekit-superforms/adapters";
import { describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-svelte";
import * as m from "$lib/paraglide/messages";
import { SkillSchema } from "$lib/server/classroom/schemas";
import SkillForm from "./SkillForm.svelte";

vi.mock("$app/forms", async (importOriginal) => ({
  ...(await importOriginal<typeof import("$app/forms")>()),
  applyAction: vi.fn(),
}));

/**
 * The pupil's skill-authoring form (plan 3.9, PRD §12, §22).
 *
 * §22 names the authoring form as component coverage. What matters about it is
 * that the three fields a skill has are all there, that an incomplete draft
 * cannot be saved, that editing carries the identifier the action needs, and
 * that the pre-approval policy is stated before the pupil presses save rather
 * than after.
 */

function form(
  overrides: {
    editingId?: string | null;
    needsApproval?: boolean;
    onsaved?: () => void;
    seed?: Record<string, string>;
  } = {},
) {
  const oncancel = vi.fn();
  const data = defaults(valibot(SkillSchema));

  render(SkillForm, {
    data: overrides.seed ? { ...data, data: { ...data.data, ...overrides.seed } } : data,
    editingId: overrides.editingId ?? null,
    needsApproval: overrides.needsApproval ?? false,
    oncancel,
    onsaved: overrides.onsaved,
  });

  return { oncancel };
}

describe("SkillForm", () => {
  it("offers the three fields a skill has (§12)", async () => {
    form();

    await expect.element(page.getByLabelText(m.student_skill_name_label())).toBeVisible();
    await expect.element(page.getByLabelText(m.student_skill_description_label())).toBeVisible();
    await expect.element(page.getByLabelText(m.student_skill_body_label())).toBeVisible();
  });

  it("will not save a draft with no name or no instructions", async () => {
    form();

    const save = page.getByRole("button", { name: m.student_skill_save() });
    await expect.element(save).toBeDisabled();

    await page.getByLabelText(m.student_skill_name_label()).fill("min-stil");
    await expect.element(save).toBeDisabled();

    await page.getByLabelText(m.student_skill_body_label()).fill("Svar altid med en analogi.");
    await expect.element(save).toBeEnabled();
  });

  it("carries the identifier of the skill being edited", async () => {
    form({ editingId: "0b2f6a2e-6f0a-4d70-9d8a-2f4f2d0e1c11", seed: { name: "min-stil" } });

    const hidden = document.querySelector('input[name="skillId"]');
    expect(hidden).toHaveValue("0b2f6a2e-6f0a-4d70-9d8a-2f4f2d0e1c11");
  });

  it("offers a way out of an edit, and reports it once", async () => {
    const { oncancel } = form({ editingId: "0b2f6a2e-6f0a-4d70-9d8a-2f4f2d0e1c11" });

    await page.getByRole("button", { name: m.student_skill_cancel() }).click();

    expect(oncancel).toHaveBeenCalledTimes(1);
  });

  it("reports a successful save once", async () => {
    const onsaved = vi.fn();
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ type: "success", status: 200 })));

    form({ onsaved });
    await page.getByLabelText(m.student_skill_name_label()).fill("min-stil");
    await page.getByLabelText(m.student_skill_body_label()).fill("Svar altid med en analogi.");
    await page.getByRole("button", { name: m.student_skill_save() }).click();

    await expect.poll(() => onsaved.mock.calls.length).toBe(1);
    fetch.mockRestore();
  });

  it("says that a version will wait for approval before the pupil saves it (§12)", async () => {
    form({ needsApproval: true });

    await expect.element(page.getByText(m.student_skill_pending_notice())).toBeVisible();
  });

  it("says nothing about approval where the classroom does not require it", async () => {
    form({ needsApproval: false });

    await expect.element(page.getByText(m.student_skill_pending_notice())).not.toBeInTheDocument();
  });
});
