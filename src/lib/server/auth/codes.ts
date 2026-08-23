/**
 * Student access codes (PRD §7).
 *
 * One high-entropy code is the whole credential: no username, no password, no
 * email. The plaintext is shown exactly twice — at provisioning and at rotation
 * — and is never persisted and never logged (§7, §21). The server keeps an
 * HMAC-SHA-256 digest under a pepper held outside the database, plus a short
 * non-secret tail that identifies a printed card during support.
 *
 * The pepper is a parameter rather than an import: this module is pure, so
 * `bun test` exercises it without an environment, and the only place the real
 * pepper is read stays the composition root.
 */

/** PRD §7 floor. 15 bytes = 120 bits, and 120 divides evenly into 5-bit Base32 symbols. */
const CODE_BYTES = 15;
export const CODE_LENGTH = 24;

/** Crockford Base32: no I, L, O or U, so nothing reads as another symbol on a card. */
const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Groups of four, hyphen separated. Presentation only — not a security boundary (§7). */
const DISPLAY_GROUP_SIZE = 4;

/** Trailing characters retained to identify a card. Never enough to reconstruct a code (§7). */
const HINT_LENGTH = 4;

/**
 * Crockford's decode aliases: O reads as 0, and I and L read as 1. Applied so a
 * student who types the letter for the digit still gets in.
 */
const DECODE_ALIASES: Record<string, string> = { O: "0", I: "1", L: "1" };

export interface GeneratedCode {
  /** Grouped for display. Shown once, then never recoverable (§7). */
  readonly display: string;
  /** Canonical, ungrouped. What the digest is computed over. */
  readonly normalised: string;
  /** Non-secret trailing characters, safe to persist alongside the digest (§7). */
  readonly hint: string;
}

/** Encode bytes as Crockford Base32, most-significant bit first. */
function encodeCrockford(bytes: Uint8Array): string {
  let out = "";
  let buffer = 0;
  let bits = 0;

  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += CROCKFORD_ALPHABET[(buffer >> bits) & 0b11111];
    }
  }
  if (bits > 0) out += CROCKFORD_ALPHABET[(buffer << (5 - bits)) & 0b11111];

  return out;
}

/** Insert the display grouping. */
export function formatCodeForDisplay(normalised: string): string {
  const groups: string[] = [];
  for (let i = 0; i < normalised.length; i += DISPLAY_GROUP_SIZE) {
    groups.push(normalised.slice(i, i + DISPLAY_GROUP_SIZE));
  }
  return groups.join("-");
}

/**
 * Canonicalise typed input: strip separators and whitespace, upper-case, and
 * apply the Crockford aliases. Every path that digests a code goes through this,
 * so a grouped code and a typed one produce the same digest.
 */
export function normaliseCode(raw: string): string {
  let out = "";
  for (const char of raw.toUpperCase()) {
    if (char === "-" || char === " " || char === "\t") continue;
    out += DECODE_ALIASES[char] ?? char;
  }
  return out;
}

/** True when the input could be a code at all. Cheap pre-filter; never a substitute for the digest lookup. */
export function isPlausibleCode(normalised: string): boolean {
  if (normalised.length !== CODE_LENGTH) return false;
  for (const char of normalised) {
    if (!CROCKFORD_ALPHABET.includes(char)) return false;
  }
  return true;
}

/** Mint a code from the platform CSPRNG (§7, §21). */
export function generateCode(): GeneratedCode {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_BYTES));
  const normalised = encodeCrockford(bytes);

  return {
    normalised,
    display: formatCodeForDisplay(normalised),
    hint: normalised.slice(-HINT_LENGTH),
  };
}

/**
 * HMAC-SHA-256 of the canonicalised code under the pepper, hex encoded.
 *
 * Keyed rather than plain: the digest column is uniquely indexed for direct
 * lookup, and without the pepper a stolen database cannot be attacked offline
 * for codes (§7).
 */
export async function digestCode(code: string, pepper: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(pepper),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(normaliseCode(code)),
  );

  return Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
