import type { GatewayAdapter } from "./adapter";

/**
 * Gateway reachability for the panel (PRD §9, §17).
 *
 * "Gateway health and available-model counts appear in the educator panel."
 *
 * Deliberately two facts and no third: reachable or not, and how many models the
 * gateway offers. No status code, no upstream URL, no provider name, no error
 * text — §9 and §21 keep all of that out of the browser, and an educator cannot
 * act on any of it anyway. What they can act on is "the gateway is down", and
 * that is what this says.
 */

export interface GatewayHealth {
  readonly reachable: boolean;
  /** Models the gateway reports. Zero on an unreachable gateway. */
  readonly modelCount: number;
}

/** A probe must not hold a panel page load open on a gateway that is hanging. */
export const HEALTH_TIMEOUT_MS = 3_000;

export async function checkGatewayHealth(
  adapter: GatewayAdapter,
  timeoutMs: number = HEALTH_TIMEOUT_MS,
): Promise<GatewayHealth> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);

  try {
    // The OpenAI-compatible dialect is CPA's default and lists every model it
    // serves regardless of which dialect an alias selects (§9).
    const models = await adapter.listModels("openai", abort.signal);
    return { reachable: true, modelCount: models.length };
  } catch {
    // Every failure is the same fact to an educator: it is not answering.
    return { reachable: false, modelCount: 0 };
  } finally {
    clearTimeout(timer);
  }
}
