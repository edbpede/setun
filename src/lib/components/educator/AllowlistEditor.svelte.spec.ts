import { describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-svelte";
import * as m from "$lib/paraglide/messages";
import AllowlistEditor from "./AllowlistEditor.svelte";

/**
 * The classroom model allowlist and its no-DPA confirmation
 * (plan 2.6, PRD §9, §16, §22).
 *
 * "The panel displays this flag wherever aliases are allowlisted, and enabling a
 * no-DPA alias for a classroom requires an explicit confirmation that states
 * plainly what it means" (§16).
 *
 * Two claims are tested here: the flag is visible on the row without opening
 * anything, and an alias without an agreement cannot be allowlisted without the
 * dialog — including that the submitted form carries the acknowledgement the
 * server insists on.
 */

const PROTECTED = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Balanced",
  available: true,
  dataProtection: true,
  allowed: false,
};

const UNPROTECTED = {
  id: "22222222-2222-4222-8222-222222222222",
  name: "Fast",
  available: true,
  dataProtection: false,
  allowed: false,
};

describe("AllowlistEditor", () => {
  it("shows the data-protection flag on every row, unopened (§16)", async () => {
    render(AllowlistEditor, { aliases: [PROTECTED, UNPROTECTED] });

    // Exact, because "No data processing agreement" contains the other label.
    await expect
      .element(page.getByText(m.educator_alias_dpa_badge(), { exact: true }))
      .toBeInTheDocument();
    await expect
      .element(page.getByText(m.educator_alias_no_dpa_badge(), { exact: true }))
      .toBeInTheDocument();
  });

  it("allowlists a covered alias directly, with no dialog in the way", async () => {
    render(AllowlistEditor, { aliases: [PROTECTED] });

    await expect.element(page.getByText(m.educator_no_dpa_confirm_title())).not.toBeInTheDocument();

    // A plain submit button, not a dialog trigger.
    const allow = page.getByRole("button", { name: m.educator_allowlist_allow() });
    await expect.element(allow).toHaveAttribute("type", "submit");
  });

  it("demands the confirmation before allowlisting an uncovered alias (§16)", async () => {
    render(AllowlistEditor, { aliases: [UNPROTECTED] });

    await page.getByRole("button", { name: m.educator_allowlist_allow() }).click();

    await expect.element(page.getByText(m.educator_no_dpa_confirm_title())).toBeInTheDocument();
    // The body states what the choice means, in §16's own terms.
    await expect.element(page.getByText(m.educator_no_dpa_confirm_body())).toBeInTheDocument();
  });

  it("carries the recorded acknowledgement in the confirmed submission", async () => {
    render(AllowlistEditor, { aliases: [UNPROTECTED] });

    await page.getByRole("button", { name: m.educator_allowlist_allow() }).click();
    await expect.element(page.getByText(m.educator_no_dpa_confirm_title())).toBeInTheDocument();

    // The dialog renders in a portal, so the document is the search root.
    const confirmation = document.querySelector<HTMLInputElement>('input[name="confirmNoDpa"]');
    const target = document.querySelector<HTMLInputElement>(
      'form[action="?/allowAlias"] input[name="modelAliasId"]',
    );

    expect(confirmation?.value).toBe("on");
    expect(target?.value).toBe(UNPROTECTED.id);
  });

  it("lets an educator back out without allowlisting anything", async () => {
    render(AllowlistEditor, { aliases: [UNPROTECTED] });

    await page.getByRole("button", { name: m.educator_allowlist_allow() }).click();
    await page.getByRole("button", { name: m.educator_no_dpa_confirm_cancel() }).click();

    await expect.element(page.getByText(m.educator_no_dpa_confirm_title())).not.toBeInTheDocument();
  });

  it("offers removal rather than allowlisting for an alias already allowed", async () => {
    render(AllowlistEditor, { aliases: [{ ...PROTECTED, allowed: true }] });

    await expect
      .element(page.getByRole("button", { name: m.educator_allowlist_disallow() }))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: m.educator_allowlist_allow() }))
      .not.toBeInTheDocument();
  });
});
