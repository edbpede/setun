import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-svelte";
import * as m from "$lib/paraglide/messages";
import CredentialCards from "./CredentialCards.svelte";

const pdfMocks = vi.hoisted(() => ({ createAccessSlipPdf: vi.fn() }));
vi.mock("$lib/access-slip-pdf", () => pdfMocks);

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
  afterEach(() => vi.restoreAllMocks());

  function renderCards(cards = CARDS, scope: "student" | "classroom" = "classroom") {
    return render(CredentialCards, {
      cards,
      classroomName: "7.B",
      locale: "da",
      appOrigin: "https://setun.example.org",
      scope,
    });
  }

  it("renders nothing at all when there are no cards", () => {
    renderCards([]);

    expect(document.body.textContent).not.toContain(m.educator_slips_title());
  });

  it("shows Setun branding, labels, codes, instructions, classroom and QR paths", async () => {
    renderCards();

    expect(
      [...document.querySelectorAll("[data-slip-label]")].map((node) => node.textContent),
    ).toEqual(CARDS.map((card) => card.label));
    expect(
      [...document.querySelectorAll("[data-slip-code]")].map((node) => node.textContent),
    ).toEqual(CARDS.map((card) => card.code));

    expect(document.body.textContent).toContain("Setun");
    expect(document.body.textContent).toContain("7.B");
    expect(document.body.textContent).toContain(
      m.educator_slip_sign_in_instruction({}, { locale: "da" }),
    );
    expect(document.querySelectorAll("svg[data-access-slip-page] path")).toHaveLength(2);
  });

  it("warns that the codes are shown once, before the educator navigates away (§7)", async () => {
    renderCards();

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
    renderCards();

    // One line per card, so the assertion is on the page's text rather than on
    // a single element.
    expect(document.body.textContent).toContain(
      m.educator_slip_keep_instruction({}, { locale: "da" }),
    );
    expect(document.body.textContent).not.toContain(
      m.educator_slip_keep_instruction({}, { locale: "en" }),
    );
  });

  it("paginates one, partial and multi-page batches", () => {
    renderCards(
      Array.from({ length: 17 }, (_, index) => ({ ...CARDS[0], label: `pupil-${index}` })),
    );

    expect(document.querySelectorAll("svg[data-access-slip-page]")).toHaveLength(3);
    expect(document.querySelectorAll("[data-slip-code]")).toHaveLength(17);
  });

  it("offers separate print and PDF controls and keeps the preview after print returns", async () => {
    const print = vi.spyOn(window, "print").mockImplementation(() => undefined);
    renderCards(CARDS.slice(0, 1), "student");

    await expect
      .element(page.getByRole("button", { name: m.educator_print() }))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: m.educator_slip_download() }))
      .toBeInTheDocument();

    await page.getByRole("button", { name: m.educator_print() }).click();
    expect(print).toHaveBeenCalledOnce();
    expect(document.querySelector("[data-slip-code]")?.textContent).toBe(CARDS[0].code);
  });

  it("keeps the manual code and warns when QR generation fails", async () => {
    const card = { ...CARDS[0], code: "A".repeat(4_000) };
    renderCards([card], "student");

    expect(document.querySelector("[data-slip-code]")?.textContent).toBe(card.code);
    await expect.element(page.getByRole("alert")).toHaveTextContent(m.educator_slip_qr_warning());
  });

  it("reports a PDF failure and re-enables the download control", async () => {
    pdfMocks.createAccessSlipPdf.mockRejectedValueOnce(new Error("test PDF failure"));
    renderCards(CARDS.slice(0, 1), "student");

    const download = page.getByRole("button", { name: m.educator_slip_download() });
    await download.click();
    await expect.element(page.getByText(m.educator_slip_pdf_failed())).toBeInTheDocument();
    await expect.element(download).toBeEnabled();
  });
});
