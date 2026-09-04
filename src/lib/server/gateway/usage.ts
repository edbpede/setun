import type { FinishReason, UsageEventPayload } from "./events";

/**
 * Token accounting for responses the gateway did not report usage for (PRD §10).
 *
 * "Token accounting relies on gateway-reported usage; when a response carries
 * none, Setun estimates it (roughly four characters per token) and records the
 * figure as estimated — usage is never counted as zero."
 */

/** The PRD's stated ratio (§10). */
export const CHARS_PER_TOKEN = 4;

/**
 * Estimate a token count from text.
 *
 * Any non-empty text costs at least one token: the invariant this protects is
 * that a response which produced output is never accounted as free.
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.max(1, Math.ceil(text.length / CHARS_PER_TOKEN));
}

/**
 * Reconcile whatever the dialect extracted into a usage event.
 *
 * Gateway-reported figures win. A partially reported response — input counted,
 * output missing, which some providers do on an aborted stream — is estimated
 * for the missing side only and flagged as estimated overall, because a mixed
 * figure is not a reported one.
 */
export function resolveUsage(input: {
  reported?: { inputTokens?: number; outputTokens?: number };
  promptText: string;
  completionText: string;
  /**
   * Why the provider stopped, when it said (§10).
   *
   * Copied through rather than derived: a response cut at the provider's own
   * output ceiling looks exactly like a finished sentence from here, and only
   * the dialect saw the difference.
   */
  finishReason?: FinishReason;
}): UsageEventPayload {
  const finish = input.finishReason ? { finishReason: input.finishReason } : {};

  const reportedInput = input.reported?.inputTokens;
  const reportedOutput = input.reported?.outputTokens;

  const inputKnown = typeof reportedInput === "number" && reportedInput > 0;
  const outputKnown = typeof reportedOutput === "number" && reportedOutput > 0;

  // An empty completion legitimately costs zero output tokens; treat a reported
  // zero as authoritative only when the response produced no text at all.
  if (inputKnown && (outputKnown || input.completionText.length === 0)) {
    return {
      type: "usage",
      inputTokens: reportedInput,
      outputTokens: reportedOutput ?? 0,
      estimated: false,
      ...finish,
    };
  }

  return {
    type: "usage",
    inputTokens: inputKnown ? reportedInput : estimateTokens(input.promptText),
    outputTokens: outputKnown ? reportedOutput : estimateTokens(input.completionText),
    estimated: true,
    ...finish,
  };
}
