import { CODE_LENGTH, generateCode, isPlausibleCode, normaliseCode } from "./codes";
import { constantTimeEquals } from "./constant-time";

/**
 * The bootstrap token — proof of host access for the first-run wizard
 * (PRD §6.2, §7, §21).
 *
 * A cold installation has no educator account and therefore no credential to
 * authenticate the person who is about to create one. Something has to stand in
 * for that, and the only thing that distinguishes the operator from a passer-by
 * at that moment is *access to the host*. So the token is minted in memory at
 * boot and printed to the console: reading it proves you can read the container's
 * logs, which is the property being tested.
 *
 * **Why this prints when `boot.ts` deliberately refuses to print student codes.**
 * That refusal (§21) is about a credential with a term-long life, one per pupil,
 * that ends up in a log file somebody keeps. This is the opposite on every axis:
 * it lives fifteen minutes, there is exactly one, it authorises exactly one
 * irreversible action, and it is worthless the moment setup completes. Printing
 * it is not an exception to the log-hygiene rule so much as the one case where
 * the console is the *only* channel that can carry the proof at all. It is
 * exempted from the redaction sweep deliberately, and the exemption is written
 * down here and in `docs/setun-operations.md` rather than discovered later.
 *
 * The format is `generateCode()` unchanged — the same Crockford Base32 alphabet,
 * the same 120 bits, the same display grouping and the same typo aliases as an
 * access code. A second alphabet would be a second thing to get wrong, and this
 * one is already the format an operator retypes off a console without ambiguity
 * between O and 0.
 *
 * There is no rejection sampling, and adding some would be a mistake. Rejection
 * sampling is the fix for a modulo bias, and a modulo bias comes from folding
 * 256 byte values onto an alphabet that does not divide 256. Crockford Base32
 * has 32 symbols and the encoder emits exactly five bits per symbol, so every
 * symbol is uniform by construction and there is no modulo anywhere to be biased.
 */

/**
 * How long a printed token is worth typing.
 *
 * Long enough to walk from the terminal to a browser and paste it, short enough
 * that a token left in a scrollback is worthless by the time anyone finds it. A
 * restart mints a fresh one; that is the documented recovery when it lapses.
 */
export const BOOTSTRAP_TOKEN_TTL_MS = 15 * 60 * 1000;

export interface BootstrapToken {
  /** Grouped for reading off a console. What the banner prints. */
  readonly display: string;
  /** Canonical form. What a submission is compared against. */
  readonly normalised: string;
  readonly expiresAt: Date;
}

/**
 * The live token, held for the process's lifetime.
 *
 * A class rather than a module-level `let`, because mutable module-scope state
 * in a server module is the anti-pattern this codebase's rules name explicitly:
 * it is invisible to a reader of the request path and impossible to reset in a
 * test. The composition root already owns the process-lifetime singletons, so
 * this joins them there — and a suite constructs its own holder per test with no
 * global to clean up.
 */
export class BootstrapTokenHolder {
  #token: BootstrapToken | null = null;

  /**
   * Mint a fresh token, discarding any predecessor.
   *
   * Re-minting is what a restart does, and it invalidates the previous token by
   * construction: there is only ever one, and it is only ever here.
   */
  mint(now: Date = new Date()): BootstrapToken {
    const code = generateCode();
    this.#token = {
      display: code.display,
      normalised: code.normalised,
      expiresAt: new Date(now.getTime() + BOOTSTRAP_TOKEN_TTL_MS),
    };
    return this.#token;
  }

  /**
   * The live token, or null.
   *
   * Expiry is evaluated here rather than on a timer: a token nobody asks about
   * does not need to be reaped, and a timer would be a second thing that has to
   * be cancelled on shutdown.
   */
  current(now: Date = new Date()): BootstrapToken | null {
    if (this.#token && this.#token.expiresAt.getTime() <= now.getTime()) this.#token = null;
    return this.#token;
  }

  /**
   * Whether a submission matches the live token.
   *
   * The length-and-alphabet pre-filter runs first so a caller cannot make the
   * server do unbounded work by posting a megabyte field, and the comparison
   * that follows is constant-time over the normalised forms — a token typed with
   * hyphens, in lower case, or with an O for a zero still matches, because those
   * are the mistakes retyping off a console actually produces (§7).
   */
  verify(submitted: string, now: Date = new Date()): boolean {
    const token = this.current(now);
    if (!token) return false;

    const normalised = normaliseCode(submitted);
    if (!isPlausibleCode(normalised)) return false;

    return constantTimeEquals(normalised, token.normalised);
  }

  /** Forget the token: on completion, and on process exit. */
  clear(): void {
    this.#token = null;
  }
}

/**
 * The one operator-facing line about the token.
 *
 * Built here rather than in `boot.ts` so the argument above and the text an
 * operator reads stay in the same file, and so a test can assert the banner
 * carries the URL and the expiry without capturing stdout.
 */
export function bootstrapBanner(input: { token: BootstrapToken; appOrigin: string }): string {
  const minutes = Math.round(BOOTSTRAP_TOKEN_TTL_MS / 60_000);
  const url = new URL("/setup", input.appOrigin).toString();

  return [
    "",
    "  ┌─ Setun first-run setup ────────────────────────────────────────",
    `  │  Open   ${url}`,
    `  │  Token  ${input.token.display}`,
    `  │  Valid for ${minutes} minutes. Restarting mints a new one and`,
    "  │  invalidates this one.",
    "  └───────────────────────────────────────────────────────────────",
    "",
  ].join("\n");
}

/** Re-exported so the wizard's own input bound and the token format agree. */
export { CODE_LENGTH as BOOTSTRAP_TOKEN_LENGTH };
