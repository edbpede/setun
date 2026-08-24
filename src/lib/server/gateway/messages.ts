import type { GatewayMessage } from "./dialect";

/**
 * Shape helpers shared by both dialects (PRD §9).
 *
 * A second dialect importing from the first would make one of them the base
 * class of the other, which is exactly the coupling the two-dialects-behind-one-
 * interface arrangement exists to avoid.
 */

/**
 * The plain text of a request, for the estimate that runs when the gateway
 * reports no usage (§10).
 *
 * Image parts contribute nothing: their tokens are the provider's arithmetic,
 * not a character count, and inventing one would be worse than the honest
 * under-count that the estimated flag already marks as approximate.
 */
export function promptTextOf(messages: readonly GatewayMessage[]): string {
  return messages
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : message.content.map((part) => (part.type === "text" ? part.text : "")).join(""),
    )
    .join("\n");
}
