import { describe, expect, it } from "bun:test";
import { estimateCost, estimateUsageCost } from "./cost-estimate";

/**
 * Display-only cost estimates (plan 2.8, PRD §10, Appendix A).
 *
 * "Per-alias prices are USD per million tokens, input and output separately; a
 * single filled price applies to both directions. Exchange rate defaults to 7.00
 * DKK/USD… estimates are display-only."
 */

const RATE = 7.0;

describe("estimateCost", () => {
  it("prices each direction at its own rate", () => {
    const estimate = estimateCost({
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      inputPricePerMillion: 3,
      outputPricePerMillion: 15,
      exchangeRate: RATE,
    });

    expect(estimate.usd).toBe(18);
    expect(estimate.dkk).toBe(126);
  });

  it("applies a single filled price to both directions (Appendix A)", () => {
    const inputOnly = estimateCost({
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      inputPricePerMillion: 2,
      outputPricePerMillion: null,
      exchangeRate: RATE,
    });
    const outputOnly = estimateCost({
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      inputPricePerMillion: null,
      outputPricePerMillion: 2,
      exchangeRate: RATE,
    });

    expect(inputOnly.usd).toBe(4);
    expect(outputOnly.usd).toBe(4);
  });

  it("gives no estimate when the alias carries no price at all", () => {
    const estimate = estimateCost({
      inputTokens: 500_000,
      outputTokens: 500_000,
      inputPricePerMillion: null,
      outputPricePerMillion: null,
      exchangeRate: RATE,
    });

    // Null, not zero: an unpriced alias is unknown, never free (§10).
    expect(estimate).toEqual({ usd: null, dkk: null });
  });

  it("omits the DKK figure when no exchange rate is configured", () => {
    const estimate = estimateCost({
      inputTokens: 1_000_000,
      outputTokens: 0,
      inputPricePerMillion: 1,
      outputPricePerMillion: 1,
      exchangeRate: 0,
    });

    expect(estimate.usd).toBe(1);
    expect(estimate.dkk).toBeNull();
  });

  it("converts at the configured rate rather than the Appendix A default", () => {
    const estimate = estimateCost({
      inputTokens: 1_000_000,
      outputTokens: 0,
      inputPricePerMillion: 1,
      outputPricePerMillion: 1,
      exchangeRate: 6.5,
    });

    expect(estimate.dkk).toBe(6.5);
  });
});

describe("estimateUsageCost — a day across several aliases", () => {
  it("sums the priced rows", () => {
    const estimate = estimateUsageCost(
      [
        {
          inputTokens: 1_000_000,
          outputTokens: 0,
          inputPricePerMillion: 3,
          outputPricePerMillion: 3,
        },
        {
          inputTokens: 0,
          outputTokens: 1_000_000,
          inputPricePerMillion: 15,
          outputPricePerMillion: 15,
        },
      ],
      RATE,
    );

    expect(estimate.usd).toBe(18);
    expect(estimate.dkk).toBe(126);
  });

  it("skips unpriced aliases rather than counting them as free", () => {
    const estimate = estimateUsageCost(
      [
        {
          inputTokens: 1_000_000,
          outputTokens: 0,
          inputPricePerMillion: 4,
          outputPricePerMillion: 4,
        },
        {
          inputTokens: 9_000_000,
          outputTokens: 9_000_000,
          inputPricePerMillion: null,
          outputPricePerMillion: null,
        },
      ],
      RATE,
    );

    // The priced row alone. The unpriced one contributed nothing — the figure is
    // approximate and labelled as such (§10).
    expect(estimate.usd).toBe(4);
  });

  it("gives no estimate when nothing carried a price", () => {
    const estimate = estimateUsageCost(
      [
        {
          inputTokens: 5_000,
          outputTokens: 5_000,
          inputPricePerMillion: null,
          outputPricePerMillion: null,
        },
      ],
      RATE,
    );

    expect(estimate).toEqual({ usd: null, dkk: null });
  });

  it("gives no estimate for a day with no usage", () => {
    expect(estimateUsageCost([], RATE)).toEqual({ usd: null, dkk: null });
  });
});
