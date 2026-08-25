import { describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-svelte";
import * as m from "$lib/paraglide/messages";
import type { RosterEntry } from "$lib/server/classroom/roster";
import RosterTable from "./RosterTable.svelte";

/**
 * The roster's actions and its silences (plan 5.1, PRD §16, §17, §22).
 *
 * Two claims are tested here. First, §16's three distinctions are three distinct
 * controls: switching a pupil off, removing them from the class, and deleting
 * them for good, with the last asking for the label back. Second — and this is
 * the one worth a test — the roster shows account state and counters and nothing
 * a pupil wrote: "educators have no interface for reading student conversations
 * — the pilot deliberately omits one" (§16).
 */

const BASE: RosterEntry = {
  id: "11111111-1111-4111-8111-111111111111",
  label: "modig-odder",
  displayName: null,
  status: "active",
  instructions: null,
  attachmentsOverride: null,
  attachmentsEffective: true,
  credentialHint: "7Q2M",
  lastActivityAt: null,
  usedTokens: 12_000,
  limitTokens: 250_000,
  exhausted: false,
  costUsd: null,
  costDkk: null,
};

describe("RosterTable", () => {
  it("offers switching off, removal and permanent deletion as three actions (§16)", async () => {
    render(RosterTable, { students: [BASE] });

    await expect
      .element(page.getByRole("button", { name: m.educator_student_disable() }))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: m.educator_student_remove() }))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: m.educator_student_delete() }))
      .toBeInTheDocument();
  });

  it("asks for the label back before deleting for good (§16)", async () => {
    render(RosterTable, { students: [BASE] });

    await expect
      .element(page.getByText(m.educator_student_delete_confirm_label({ label: BASE.label })))
      .toBeInTheDocument();
  });

  it("offers switching on rather than off for a pupil already disabled", async () => {
    render(RosterTable, { students: [{ ...BASE, status: "disabled" }] });

    await expect
      .element(page.getByRole("button", { name: m.educator_student_enable() }))
      .toBeInTheDocument();
    await expect
      .element(page.getByText(m.educator_status_disabled(), { exact: true }))
      .toBeInTheDocument();
  });

  it("does not offer removal again for a pupil already removed", async () => {
    render(RosterTable, { students: [{ ...BASE, status: "removed" }] });

    await expect
      .element(page.getByRole("button", { name: m.educator_student_remove() }))
      .not.toBeInTheDocument();
  });

  it("offers no nickname-clearing control for a pupil who set none (§16)", async () => {
    render(RosterTable, { students: [BASE] });

    await expect
      .element(page.getByRole("button", { name: m.educator_clear_display_name() }))
      .not.toBeInTheDocument();
  });

  it("offers to clear a nickname where one is set (§16)", async () => {
    render(RosterTable, { students: [{ ...BASE, displayName: "Rumfaren" }] });

    await expect
      .element(page.getByRole("button", { name: m.educator_clear_display_name() }))
      .toBeInTheDocument();
  });

  it("shows the attachment override as following the class until one is set (§10)", async () => {
    render(RosterTable, { students: [BASE] });

    const select = document.querySelector<HTMLSelectElement>('select[name="attachments"]');
    expect(select?.value).toBe("inherit");
  });

  it("shows usage, last activity and the card's tail — and nothing a pupil wrote (§16)", async () => {
    render(RosterTable, {
      students: [{ ...BASE, lastActivityAt: new Date("2026-08-25T09:00:00Z") }],
    });

    await expect
      .element(page.getByText(m.educator_card_hint({ hint: "7Q2M" })))
      .toBeInTheDocument();

    // The educator's own text is editable; there is no field carrying the
    // pupil's, because no such field exists on the shape (§16).
    const fields = [...document.querySelectorAll("textarea")].map((node) => node.name);
    expect(fields).toEqual(["instructions"]);
  });

  it("reports a delete confirmation that did not match, without deleting", async () => {
    render(RosterTable, { students: [BASE], confirmMismatch: BASE.id });

    await expect.element(page.getByText(m.educator_student_delete_mismatch())).toBeInTheDocument();
  });
});
