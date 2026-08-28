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

/**
 * The model identifiers the gateway serves, or null when it is not answering.
 *
 * Separate from `checkGatewayHealth`, which deliberately reduces the answer to
 * "reachable, and how many" because that is all an educator needs. The setup
 * wizard needs the identifiers themselves, so it can tell an operator that the
 * one they typed is not among them — a typo there produces an installation whose
 * only model points at nothing, and whose utility model does too.
 *
 * Null rather than an empty array on failure, so a caller can tell "the gateway
 * says it serves nothing" from "the gateway did not answer" and decline to
 * block on the second.
 */
export async function listGatewayModelIds(
  adapter: GatewayAdapter,
  timeoutMs: number = HEALTH_TIMEOUT_MS,
): Promise<string[] | null> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);

  try {
    const models = await adapter.listModels("openai", abort.signal);
    return models.map((model) => model.id);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The identifier without its reasoning-effort suffix.
 *
 * `gpt-5.6-luna(high)` is CLIProxyAPI's syntax: the gateway strips the
 * parenthesised part before routing, so the name it lists is the bare one and a
 * literal comparison would reject every alias that sets an effort.
 */
export function baseModelId(gatewayModelId: string): string {
  return gatewayModelId.replace(/\([^)]*\)\s*$/, "").trim();
}
