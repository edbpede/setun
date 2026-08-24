import { describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-svelte";
import * as m from "$lib/paraglide/messages";
import ElicitationForm from "./ElicitationForm.svelte";
import PermissionPrompt from "./PermissionPrompt.svelte";

/**
 * The permission prompt and the elicitation form (plan 3.4, 3.5, PRD §11, §22).
 *
 * §22 names the permission prompt as component coverage. What is asserted is
 * what §11 requires of it: unmissable server attribution, an approve and a
 * decline that each report exactly once, and — for elicitation — that only the
 * flat primitives are rendered and that skipping is always available.
 */

function permission(overrides: Partial<Parameters<typeof PermissionPrompt>[1]> = {}) {
  const onrespond = vi.fn();

  render(PermissionPrompt, {
    permission: {
      toolCallId: "call-1",
      toolName: "docs__search",
      serverLabel: "Skolens dokumenter",
      sensitive: false,
      arguments: { q: "loops" },
    },
    onrespond,
    ...overrides,
  });

  return { onrespond };
}

describe("PermissionPrompt", () => {
  it("names the server the tool belongs to (§11)", async () => {
    permission();

    await expect
      .element(page.getByText(m.chat_permission_from({ server: "Skolens dokumenter" })))
      .toBeVisible();
    await expect.element(page.getByText("docs__search")).toBeVisible();
  });

  it("says a tool is built into Setun when it belongs to no server", async () => {
    const onrespond = vi.fn();
    render(PermissionPrompt, {
      permission: {
        toolCallId: "call-2",
        toolName: "generate_image",
        serverLabel: null,
        sensitive: false,
        arguments: {},
      },
      onrespond,
    });

    await expect.element(page.getByText(m.chat_permission_internal())).toBeVisible();
  });

  it("approves once when the pupil says yes", async () => {
    const { onrespond } = permission();

    await page.getByRole("button", { name: m.chat_permission_approve() }).click();

    expect(onrespond).toHaveBeenCalledTimes(1);
    expect(onrespond).toHaveBeenCalledWith(true);
  });

  it("declines once when the pupil says no", async () => {
    const { onrespond } = permission();

    await page.getByRole("button", { name: m.chat_permission_decline() }).click();

    expect(onrespond).toHaveBeenCalledTimes(1);
    expect(onrespond).toHaveBeenCalledWith(false);
  });

  it("shows what the call will do, so the pupil approves something specific", async () => {
    permission();

    await page.getByText(m.chat_permission_details()).click();
    await expect.element(page.getByText(/loops/)).toBeVisible();
  });

  it("says when the teacher marked the tool as one to ask about", async () => {
    const onrespond = vi.fn();
    render(PermissionPrompt, {
      permission: {
        toolCallId: "call-3",
        toolName: "docs__delete",
        serverLabel: "Skolens dokumenter",
        sensitive: true,
        arguments: {},
      },
      onrespond,
    });

    await expect.element(page.getByText(m.chat_permission_sensitive())).toBeVisible();
  });
});

describe("ElicitationForm", () => {
  function elicitation() {
    const onrespond = vi.fn();

    render(ElicitationForm, {
      elicitation: {
        toolCallId: "call-1",
        toolName: "docs__weather",
        serverLabel: "Vejrtjenesten",
        message: "Hvilken by?",
        fields: [
          { name: "city", label: "By", type: "text", required: true },
          { name: "days", label: "Dage", type: "number", required: false },
          { name: "imperial", label: "Fahrenheit", type: "boolean", required: false },
          { name: "unit", label: "Enhed", type: "choice", required: false, options: ["c", "f"] },
        ],
      },
      onrespond,
    });

    return { onrespond };
  }

  it("renders the server's question with its attribution (§11)", async () => {
    elicitation();

    await expect
      .element(page.getByText(m.chat_permission_from({ server: "Vejrtjenesten" })))
      .toBeVisible();
    await expect.element(page.getByText("Hvilken by?")).toBeVisible();
  });

  it("renders one control per flat primitive, and nothing richer", async () => {
    elicitation();

    await expect.element(page.getByRole("textbox", { name: "By" })).toBeVisible();
    await expect.element(page.getByRole("spinbutton", { name: "Dage" })).toBeVisible();
    await expect.element(page.getByRole("checkbox", { name: "Fahrenheit" })).toBeVisible();
    await expect.element(page.getByRole("combobox", { name: "Enhed" })).toBeVisible();
  });

  it("waits for a required answer before it will send", async () => {
    const { onrespond } = elicitation();

    const submit = page.getByRole("button", { name: m.chat_elicitation_submit() });
    await expect.element(submit).toBeDisabled();

    await page.getByRole("textbox", { name: "By" }).fill("Aarhus");
    await expect.element(submit).toBeEnabled();

    await submit.click();
    expect(onrespond).toHaveBeenCalledWith(
      expect.objectContaining({
        declined: false,
        values: expect.objectContaining({ city: "Aarhus" }),
      }),
    );
  });

  it("always lets the pupil skip the question (§11)", async () => {
    const { onrespond } = elicitation();

    await page.getByRole("button", { name: m.chat_elicitation_cancel() }).click();

    expect(onrespond).toHaveBeenCalledWith({ values: {}, declined: true });
  });
});
