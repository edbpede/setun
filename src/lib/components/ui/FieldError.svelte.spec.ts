import { describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-svelte";
import FieldError from "./FieldError.svelte";

/**
 * Validation messages must be announced (PRD §20, §21).
 *
 * The role is the reason this component exists: before it, a rejected form said
 * what was wrong in red text that no screen reader announced, and the page's
 * only live region carried the page title.
 */

describe("FieldError", () => {
  it("announces the message", async () => {
    render(FieldError, { message: "Enter a name." });

    await expect.element(page.getByRole("alert")).toHaveTextContent("Enter a name.");
  });

  it("takes the first of Superforms' per-field array", async () => {
    render(FieldError, { message: ["Enter a name.", "And something else."] });

    await expect.element(page.getByRole("alert")).toHaveTextContent("Enter a name.");
  });

  it("renders nothing at all when there is no message", () => {
    render(FieldError, { message: null });

    // Not an empty alert: an announced blank is an interruption saying nothing.
    expect(document.body.querySelector('[role="alert"]')).toBeNull();
  });

  it("renders nothing for an empty message array", () => {
    render(FieldError, { message: [] });

    expect(document.body.querySelector('[role="alert"]')).toBeNull();
  });
});
