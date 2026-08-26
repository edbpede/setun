import type { BootstrapTokenHolder } from "../auth/bootstrap";
import { normaliseCode } from "../auth/codes";
import { constantTimeEquals } from "../auth/constant-time";
import { attemptEducatorLogin, EDUCATOR_LOGIN_MINIMUM_DURATION_MS } from "../auth/educator";
import { checkRateLimit, recordAttempt } from "../auth/rate-limit";
import { destroySession, hashSessionToken, mintSessionToken } from "../auth/sessions";
import type { AppDatabase } from "../db/client";
import { getFirstEducator } from "../db/queries/educators";
import {
  ensureInstance,
  readInstance,
  renewClaim,
  seizeClaim,
  takeClaim,
} from "../db/queries/instance";
import type { Instance } from "../db/schema";

/**
 * The setup claim: which browser owns the in-progress first run
 * (PRD §6.2, §7, §21).
 *
 * The bootstrap token and the claim are two secrets with two jobs, and merging
 * them is the classic reimplementation bug. The **token** proves host access; it
 * lives in memory, expires in fifteen minutes, and is deliberately *reusable*
 * within that window, so an operator who loses a cookie is not forced to restart
 * the process. The **claim** is the durable record of exclusivity; it lives in
 * SQLite as a digest, expires in ten, and is what makes a second browser see a
 * `409` instead of a second wizard.
 *
 * The two lifetimes are deliberately unequal, and in that direction: because the
 * claim lapses first, an abandoned tab always becomes re-claimable while the
 * token that opened it still works.
 *
 * The proof itself is a 256-bit token minted with the same primitive a session
 * uses, stored as its SHA-256 digest and carried only in a cookie — so a
 * database read cannot mint a claim, exactly as it cannot mint a session (§21).
 * There is no encryption layer here and no key management: the digest *is* the
 * design.
 */

/** Scoped to `/setup`, so nothing else on the origin ever sees it. */
export const SETUP_CLAIM_COOKIE_NAME = "setun_setup_claim";

/** Strictly shorter than the token's fifteen minutes — see the note above. */
export const SETUP_CLAIM_TTL_MS = 10 * 60 * 1000;

/**
 * The largest instant a `Date` can represent.
 *
 * A `claimedAt` read back as something absurd — clock skew, a hand-edited row —
 * must degrade to "no claim" rather than throw a `RangeError` out of a page
 * load, which would turn a bad timestamp into a denial of setup.
 */
const MAX_TIMESTAMP_MS = 8.64e15;

export type ClaimFailureReason =
  | "setup_complete"
  | "setup_claimed"
  | "rate_limited"
  /** One opaque code for empty, malformed, wrong and expired alike (§21). */
  | "invalid_token"
  | "invalid_credentials"
  | "no_educator";

export type ClaimResult =
  | { readonly ok: true; readonly proof: string }
  | {
      readonly ok: false;
      readonly reason: ClaimFailureReason;
      /** When the live claim lapses, for the `409` screen. Null when unknown. */
      readonly retryAt: Date | null;
    };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function failure(reason: ClaimFailureReason, retryAt: Date | null = null): ClaimResult {
  return { ok: false, reason, retryAt };
}

/** A `Date`, or null when the instant cannot be represented as one. */
function representableDate(ms: number): Date | null {
  if (!Number.isFinite(ms) || Math.abs(ms) > MAX_TIMESTAMP_MS) return null;
  return new Date(ms);
}

/**
 * When the current claim lapses, or null when there is none to lapse.
 *
 * A claim timestamp in the future is treated as no claim rather than as a claim
 * that outlives everything: otherwise a skewed clock or a tampered row becomes
 * a denial-of-setup primitive that no restart clears, because the row survives
 * one.
 */
export function claimExpiresAt(row: Instance | undefined, now: Date): Date | null {
  if (!row?.claimProofDigest || !row.claimedAt) return null;

  const claimedAt = row.claimedAt.getTime();
  if (!Number.isFinite(claimedAt) || claimedAt > now.getTime()) return null;

  const expiresAt = representableDate(claimedAt + SETUP_CLAIM_TTL_MS);
  if (!expiresAt || expiresAt.getTime() <= now.getTime()) return null;

  return expiresAt;
}

/**
 * Whether the presented proof owns the live claim.
 *
 * The digest is compared in constant time, like the token — a database column
 * compared with `===` is the one asymmetry that would be left, and closing it
 * costs a function call.
 */
export function holdsClaim(
  row: Instance | undefined,
  proof: string | null,
  now: Date = new Date(),
): boolean {
  if (!proof || !row?.claimProofDigest) return false;
  if (!claimExpiresAt(row, now)) return false;

  return constantTimeEquals(hashSessionToken(proof), row.claimProofDigest);
}

/**
 * Re-verify the claim and slide it forward — what every guarded step does first.
 *
 * Sliding on each step is what keeps a working session alive without a
 * heartbeat: ten minutes is the idle allowance, not the total budget for
 * finishing setup.
 */
export function verifyAndSlideClaim(
  db: AppDatabase,
  proof: string | null,
  now: Date = new Date(),
): boolean {
  const row = readInstance(db);
  if (row?.setupCompletedAt != null) return false;
  if (!holdsClaim(row, proof, now)) return false;

  renewClaim(db, now);
  return true;
}

/** What the wizard's `load` tells the browser about somebody else's claim. */
export interface ForeignClaim {
  readonly heldElsewhere: boolean;
  readonly retryAt: Date | null;
}

export function describeForeignClaim(
  db: AppDatabase,
  proof: string | null,
  now: Date = new Date(),
): ForeignClaim {
  const row = readInstance(db);
  const expiresAt = claimExpiresAt(row, now);

  if (!expiresAt || holdsClaim(row, proof, now)) return { heldElsewhere: false, retryAt: null };
  return { heldElsewhere: true, retryAt: expiresAt };
}

/**
 * The rate-limit key for a submitted token.
 *
 * `login_attempt.scope` is the enum `["ip", "digest"]`, so a third scope would
 * mean a schema change and a migration for no gain. The budget is separated by
 * namespacing the key *inside* the digest scope instead — and because the key is
 * a digest of what was submitted rather than of anything stored, the limiter
 * still never reveals whether a token exists (§7, §21).
 *
 * `hashSessionToken` is plain SHA-256 hex; it is used here for the same reason
 * it is used for a session digest, and a second implementation of it would be a
 * second chance to diverge.
 */
function tokenRateLimitKey(token: string): string {
  return `setup:${hashSessionToken(normaliseCode(token))}`;
}

function recoverRateLimitKey(username: string): string {
  return `setup-recover:${hashSessionToken(username.trim().toLowerCase())}`;
}

/**
 * Every failure branch takes the same observable time, mirroring the educator
 * login path it sits beside — and reusing its constant rather than restating it.
 */
async function settle<T>(startedAt: number, result: T, extraDelayMs = 0): Promise<T> {
  const remaining = EDUCATOR_LOGIN_MINIMUM_DURATION_MS + extraDelayMs - (Date.now() - startedAt);
  if (remaining > 0) await sleep(remaining);
  return result;
}

/**
 * `POST /setup?/claim`.
 *
 * The order of the checks is part of the contract:
 *
 * 1. the caller already holds a valid claim — renew, idempotent;
 * 2. another session holds a live one — `409`, with the instant it lapses;
 * 3. rate limited — `429`;
 * 4. the token is empty, malformed, wrong or expired — one opaque `400`;
 * 5. otherwise mint the proof, persist its digest, and take the claim.
 *
 * Step 2 precedes step 3 deliberately: a legitimate operator retrying while a
 * colleague holds the claim must not spend their own rate-limit budget waiting.
 */
export async function claimSetup(
  db: AppDatabase,
  input: {
    token: string;
    presentedProof: string | null;
    ip: string;
    bootstrap: BootstrapTokenHolder;
    now?: Date;
  },
): Promise<ClaimResult> {
  const startedAt = Date.now();
  const now = input.now ?? new Date();

  const row = ensureInstance(db);
  if (row.setupCompletedAt !== null) return settle(startedAt, failure("setup_complete"));

  if (holdsClaim(row, input.presentedProof, now) && input.presentedProof) {
    renewClaim(db, now);
    return settle(startedAt, { ok: true, proof: input.presentedProof } as const);
  }

  const heldUntil = claimExpiresAt(row, now);
  if (heldUntil) return settle(startedAt, failure("setup_claimed", heldUntil));

  const digest = tokenRateLimitKey(input.token);
  const limit = checkRateLimit(db, { ip: input.ip, digest, now });
  if (limit.blocked) return settle(startedAt, failure("rate_limited"));

  const valid = input.bootstrap.verify(input.token, now);
  recordAttempt(db, { ip: input.ip, digest, successful: valid });
  if (!valid) return settle(startedAt, failure("invalid_token"), limit.delayMs);

  const proof = mintSessionToken();
  const won = takeClaim(db, {
    proofDigest: hashSessionToken(proof),
    now,
    staleBefore: new Date(now.getTime() - SETUP_CLAIM_TTL_MS),
  });

  // Lost a race with another browser holding the same banner. Nothing is
  // corrupted and no session was issued; the loser waits the claim out.
  if (!won) {
    return settle(startedAt, failure("setup_claimed", claimExpiresAt(readInstance(db), now)));
  }

  return settle(startedAt, { ok: true, proof } as const);
}

/**
 * `POST /setup?/recover`.
 *
 * The way back in when the token has expired and the claim cookie is gone, once
 * an operator account exists — env-seeded, or created at the wizard's first
 * step. Without it, losing a cookie fourteen minutes into a token's life would
 * mean restarting the process for no security benefit whatsoever.
 *
 * The credential check is `attemptEducatorLogin`, so the timing floor and the
 * single failure shape for "unknown username" and "wrong password" come for
 * free. The session it establishes on success is destroyed immediately: the
 * educator's real session is issued once, at the end of setup, against a
 * deliberately fresh cookie (§21).
 */
export async function recoverClaim(
  db: AppDatabase,
  input: {
    username: string;
    password: string;
    ip: string;
    now?: Date;
  },
): Promise<ClaimResult> {
  const startedAt = Date.now();
  const now = input.now ?? new Date();

  const row = ensureInstance(db);
  if (row.setupCompletedAt !== null) return settle(startedAt, failure("setup_complete"));

  // Before an account exists there is nothing to authenticate against, and the
  // bootstrap token is the only proof there can be.
  if (!getFirstEducator(db)) return settle(startedAt, failure("no_educator"));

  const digest = recoverRateLimitKey(input.username);
  const limit = checkRateLimit(db, { ip: input.ip, digest, now });
  if (limit.blocked) return settle(startedAt, failure("rate_limited"));

  const attempt = await attemptEducatorLogin(db, {
    username: input.username,
    password: input.password,
  });
  recordAttempt(db, { ip: input.ip, digest, successful: attempt.ok });

  if (!attempt.ok) return settle(startedAt, failure("invalid_credentials"), limit.delayMs);
  destroySession(db, attempt.session.token);

  const proof = mintSessionToken();
  seizeClaim(db, { proofDigest: hashSessionToken(proof), now });

  return settle(startedAt, { ok: true, proof } as const);
}
