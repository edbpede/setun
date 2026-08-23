/**
 * Display-only cost estimates (PRD §10).
 *
 * "Alongside the enforced token figures, the panel and student dashboard show an
 * approximate cost (USD and DKK) computed from the optional per-alias prices and
 * a configurable exchange rate. Estimates are display only — enforcement never
 * depends on a price being present or current."
 */

export interface CostEstimate {
  /** Null when no per-alias prices are configured. */
  readonly usd: number | null;
  /** Null when the estimate is unavailable (no prices) or the exchange rate is zero. */
  readonly dkk: number | null;
}

/**
 * Estimate the cost of `totalTokens` on an alias with the given per-million prices.
 *
 * Uses the alias's direction-specific prices when available. A single filled
 * price applies to both directions — that is the PRD §10 rule, and the reason
 * this function takes the pair rather than a pre-computed average.
 */
export function estimateCost(input: {
  inputTokens: number;
  outputTokens: number;
  inputPricePerMillion: number | null;
  outputPricePerMillion: number | null;
  exchangeRate: number;
}): CostEstimate {
  const inputPrice = input.inputPricePerMillion ?? input.outputPricePerMillion;
  const outputPrice = input.outputPricePerMillion ?? input.inputPricePerMillion;

  if (inputPrice === null || outputPrice === null) return { usd: null, dkk: null };

  const usd = (input.inputTokens * inputPrice + input.outputTokens * outputPrice) / 1_000_000;
  const dkk = input.exchangeRate > 0 ? usd * input.exchangeRate : null;

  return { usd, dkk };
}

/** One alias's share of a day's usage, with that alias's prices attached. */
export interface PricedUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly inputPricePerMillion: number | null;
  readonly outputPricePerMillion: number | null;
}

/**
 * Sum a day's usage into one estimate.
 *
 * Rows on aliases with no price contribute nothing — the estimate is
 * approximate and clearly labelled as such (§10, §18). It is null only when no
 * row carried a price at all, which is the case the display treats as "no
 * estimate available" rather than "free".
 */
export function estimateUsageCost(
  rows: readonly PricedUsage[],
  exchangeRate: number,
): CostEstimate {
  let usd: number | null = null;

  for (const row of rows) {
    const priced = estimateCost({ ...row, exchangeRate });
    if (priced.usd === null) continue;
    usd = (usd ?? 0) + priced.usd;
  }

  if (usd === null) return { usd: null, dkk: null };
  return { usd, dkk: exchangeRate > 0 ? usd * exchangeRate : null };
}
