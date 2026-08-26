import { timingSafeEqual } from "node:crypto";

/**
 * Comparison that does not leak how far it got (PRD §21).
 *
 * `===` on two strings stops at the first differing byte, so the time it takes
 * is a function of how much of the secret the caller already has. That is only
 * exploitable under a fairly patient attacker with a quiet network, which is
 * exactly why it is worth closing here rather than arguing about: both callers
 * compare short, fixed-format values, and the constant-time form costs nothing.
 *
 * Length is not treated as secret. Every value compared through this has a fixed
 * format that a length-and-alphabet pre-filter has already checked, so a
 * mismatch in length is refused before the bytes are looked at — and the work
 * is still performed, so the two branches do not differ by an obvious no-op.
 */
export function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");

  // `timingSafeEqual` throws rather than returning false on a length mismatch,
  // so the comparison is performed against a same-length buffer and discarded.
  if (left.length !== right.length) {
    timingSafeEqual(left, left);
    return false;
  }

  return timingSafeEqual(left, right);
}
