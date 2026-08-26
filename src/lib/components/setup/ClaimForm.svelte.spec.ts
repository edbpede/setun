import { describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-svelte";
import * as m from "$lib/paraglide/messages";
import ClaimForm from "./ClaimForm.svelte";

/**
 * Step 0 of the first-run wizard (plan 6.1, PRD §6.2, §7, §21, §22).
 *
 * Three claims are tested here, and each of them is a decision the server has
 * already made that the screen must not contradict: recovery is offered only
 * once there is a credential to recover with, a claim held elsewhere is a screen
 * rather than a dead end, and a failure code renders as a sentence rather than
 * as an internal identifier.
 */

const BASE = {
  error: null,
  retryAt: null,
  heldElsewhere: false,
  canRecover: false,
};

describe("ClaimForm", () => {
  it("asks for the token and says where to find it", async () => {
    render(ClaimForm, BASE);

    await expect.element(page.getByLabelText(m.setup_claim_token_label())).toBeInTheDocument();
    await expect.element(page.getByText(m.setup_claim_where())).toBeInTheDocument();
  });

  it("does not offer credential recovery before an account exists (§7)", async () => {
    render(ClaimForm, BASE);

    // Before step 1 there is nothing to authenticate against, and the bootstrap
    // token is the only proof there can be.
    await expect.element(page.getByText(m.setup_recover_title())).not.toBeInTheDocument();
  });

  it("offers credential recovery once an account exists", async () => {
    render(ClaimForm, { ...BASE, canRecover: true });

    await expect.element(page.getByText(m.setup_recover_title())).toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: m.setup_recover_submit() }))
      .toBeInTheDocument();
  });

  it("renders a claim held elsewhere as a screen with a retry time, keeping the form", async () => {
    render(ClaimForm, {
      ...BASE,
      heldElsewhere: true,
      retryAt: "2026-09-01T08:10:00.000Z",
    });

    await expect.element(page.getByText(m.setup_claim_held_title())).toBeInTheDocument();
    await expect.element(page.getByText(/\d{1,2}[.:]\d{2}/)).toBeInTheDocument();
    // Not a dead end: re-claiming reopens the moment the claim lapses.
    await expect.element(page.getByLabelText(m.setup_claim_token_label())).toBeInTheDocument();
  });

  it("turns a failure code into a sentence, never into an identifier (§21)", async () => {
    render(ClaimForm, { ...BASE, error: "invalid_token" });

    const alert = page.getByRole("alert");
    await expect.element(alert).toHaveTextContent(m.setup_error_invalid_token());
    await expect.element(alert).not.toHaveTextContent("invalid_token");
  });

  it("shows nothing for an unrecognised code rather than echoing it", async () => {
    render(ClaimForm, { ...BASE, error: "something_unmapped" });

    await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
  });
});
