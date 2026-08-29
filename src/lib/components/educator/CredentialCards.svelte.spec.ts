import { describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-svelte";
import * as m from "$lib/paraglide/messages";
import CredentialCards from "./CredentialCards.svelte";

/**
 * Printable credential cards (plan 5.1, PRD §7, §22).
 *
 * "The code is shown at provisioning and rotation only" (§7), so the component
 * has to say so where the educator will read it before navigating away — there
 * is no route that can show a code again, because nothing stores one.
 */

const CARDS = [
  { label: "modig-odder", code: "A1B2-C3D4-E5F6-G7H8-J9K0-M1N2", hint: "M1N2" },
  { label: "stille-hejre", code: "Z9Y8-X7W6-V5T4-S3R2-Q1P0-N9M8", hint: "N9M8" },
];

describe("CredentialCards", () => {
  it("renders nothing at all when there are no cards", () => {
    render(CredentialCards, { cards: [], classroomName: "7.B", locale: "da" });

    expect(document.body.textContent).not.toContain(m.educator_cards_title());
  });

  it("shows each card with its label, its code and the classroom", async () => {
    render(CredentialCards, { cards: CARDS, classroomName: "7.B", locale: "da" });

    for (const card of CARDS) {
      await expect.element(page.getByText(card.label)).toBeInTheDocument();
      await expect.element(page.getByText(card.code)).toBeInTheDocument();
    }

    expect(document.body.textContent).toContain("7.B");
  });

  it("warns that the codes are shown once, before the educator navigates away (§7)", async () => {
    render(CredentialCards, { cards: CARDS, classroomName: "7.B", locale: "da" });

    await expect.element(page.getByText(m.educator_cards_once())).toBeInTheDocument();
  });

  /**
   * The card is cut out and handed to a pupil, so it is addressed to them (§17).
   *
   * An educator running the panel in English for a Danish class was printing
   * cards a Danish pupil could not read. The chrome around the cards is the
   * educator's and stays in their language; the card itself is not.
   */
  it("prints the pupil's line in the classroom's language, not the reader's", async () => {
    render(CredentialCards, { cards: CARDS, classroomName: "7.B", locale: "da" });

    // One line per card, so the assertion is on the page's text rather than on
    // a single element.
    expect(document.body.textContent).toContain(m.educator_card_help({}, { locale: "da" }));
    expect(document.body.textContent).not.toContain(m.educator_card_help({}, { locale: "en" }));
  });

  it("offers to print", async () => {
    render(CredentialCards, { cards: CARDS, classroomName: "7.B", locale: "da" });

    await expect
      .element(page.getByRole("button", { name: m.educator_print() }))
      .toBeInTheDocument();
  });
});
