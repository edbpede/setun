import type { AppDatabase } from "../db/client";
import {
  createEducator,
  findEducatorByUsername,
  getEducatorById,
  getFirstEducator,
  updateEducatorCredential,
} from "../db/queries/educators";
import { findSessionByDigest, touchSession } from "../db/queries/sessions";
import type { Educator } from "../db/schema";
import { digestFailureDelayMs, recordDigestAttempt } from "./rate-limit";
import {
  createSession,
  EDUCATOR_SESSION_TTL_DAYS,
  hashSessionToken,
  type IssuedSession,
} from "./sessions";

/**
 * Educator authentication (PRD §7).
 *
 * "Educator authentication is separate and conventional: a single account seeded
 * from deployment configuration at first boot, password hashed with
 * `Bun.password` (argon2id), with its own session namespace and a sliding 7-day
 * expiry. There is no in-application password recovery."
 *
 * Separate from student auth in every dimension that matters: a different
 * credential kind, a different session `ownerKind`, and a different resolver.
 * The resolvers each hard-code their own `ownerKind` rather than taking it as a
 * parameter, so a student session cannot be resolved as an educator one by
 * passing the wrong argument — the role separation §21 requires is structural.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Same floor as the student path, for the same reason: a uniform observable duration (§7). */
export const EDUCATOR_LOGIN_MINIMUM_DURATION_MS = 250;

/**
 * The rate-limit key for an educator sign-in (§7).
 *
 * The operator account is the one privileged credential for the whole instance
 * and there is no password recovery inside the app, so failed sign-ins earn a
 * progressive delay on the SQLite-backed limiter the student codes and the
 * first-run token already use — the normal login was the one path left off.
 *
 * `login_attempt.scope` is the enum `["ip", "digest"]`, so the budget is
 * namespaced *inside* the digest scope rather than adding a third scope and a
 * migration — the same choice `setup/claim` makes. The key is a digest of the
 * submitted username, never of anything stored, so the limiter never reveals
 * whether an account exists (§7, §21).
 */
export function educatorRateLimitKey(username: string): string {
  return `educator:${hashSessionToken(username.trim().toLowerCase())}`;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A hash of a value no one will ever submit.
 *
 * Verifying against this when the username is unknown keeps the argon2id work —
 * by far the dominant cost of a login — on both paths, so timing does not
 * disclose whether an account exists (§7, §21).
 */
let decoyHash: string | null = null;

async function getDecoyHash(): Promise<string> {
  decoyHash ??= await Bun.password.hash(crypto.randomUUID(), { algorithm: "argon2id" });
  return decoyHash;
}

/**
 * argon2id, as §7 requires.
 *
 * One function decides the algorithm, because there are now two paths that
 * create the operator account — deployment configuration, and the first-run
 * wizard — and an algorithm chosen twice is an algorithm that can be chosen
 * differently.
 */
export function hashEducatorPassword(password: string): Promise<string> {
  return Bun.password.hash(password, { algorithm: "argon2id" });
}

export interface SeedEducatorResult {
  readonly seeded: boolean;
  readonly educator: Educator;
}

/**
 * Create or update the operator account from deployment configuration.
 *
 * Idempotent by username, and updating on a changed password is the documented
 * recovery path: "a forgotten educator password is reset by re-seeding the
 * credential in deployment configuration and restarting" (§7, §6.2).
 *
 * The stored hash is salted, so an unchanged password still hashes to a new
 * value — comparing hashes cannot detect a no-op. Verifying can, and leaving the
 * row untouched keeps a restart from churning it.
 */
export async function seedEducator(
  db: AppDatabase,
  input: { username: string; password: string },
): Promise<SeedEducatorResult> {
  const existing = findEducatorByUsername(db, input.username);

  if (existing && (await Bun.password.verify(input.password, existing.passwordHash))) {
    return { seeded: false, educator: existing };
  }

  const passwordHash = await hashEducatorPassword(input.password);
  return { seeded: true, educator: createEducator(db, { username: input.username, passwordHash }) };
}

/**
 * Create or replace *the* operator account — the first-run wizard's first step
 * (PRD §6.2, §7).
 *
 * Deliberately not `seedEducator`. That one keys on the username, which is right
 * for deployment configuration: an operator who changes the configured name
 * should get an account under it. Here the opposite is right — the wizard's
 * account step is re-runnable, and an operator who goes back and corrects a typo
 * in the username must end up with one account, not two. So an existing row is
 * updated in place and only an empty table is inserted into (§7).
 */
export async function establishEducator(
  db: AppDatabase,
  input: {
    username: string;
    password: string;
    /**
     * Re-checked after the hash and before the write; null is returned when it
     * says no.
     *
     * Hashing is the only slow step here, and it is slow on purpose. The caller
     * decided this write was allowed *before* it — so on a route whose
     * authorisation can be withdrawn mid-request, the decision is about state
     * that may no longer hold by the time the row is written. Nothing between
     * this check and the write awaits, so the two happen in one turn (§21).
     */
    stillAuthorised?: () => boolean;
  },
): Promise<Educator | null> {
  const passwordHash = await hashEducatorPassword(input.password);
  if (input.stillAuthorised && !input.stillAuthorised()) return null;

  const existing = getFirstEducator(db);

  if (existing) {
    const updated = updateEducatorCredential(db, {
      educatorId: existing.id,
      username: input.username,
      passwordHash,
    });
    if (updated) return updated;
  }

  return createEducator(db, { username: input.username, passwordHash });
}

export type EducatorLoginResult =
  | { readonly ok: true; readonly educator: Educator; readonly session: IssuedSession }
  | { readonly ok: false };

const FAILURE: EducatorLoginResult = { ok: false };

/**
 * Verify the operator credential and, on success, establish an educator session.
 *
 * One failure shape for an unknown username and a wrong password alike (§7, §21).
 */
export async function attemptEducatorLogin(
  db: AppDatabase,
  input: { username: string; password: string },
): Promise<EducatorLoginResult> {
  const startedAt = Date.now();

  const settle = async (result: EducatorLoginResult): Promise<EducatorLoginResult> => {
    const remaining = EDUCATOR_LOGIN_MINIMUM_DURATION_MS - (Date.now() - startedAt);
    if (remaining > 0) await sleep(remaining);
    return result;
  };

  const educator = findEducatorByUsername(db, input.username);

  // Unconditional: the verify is the expensive half, and skipping it for an
  // unknown username is precisely what would make the two cases distinguishable.
  const verified = await Bun.password.verify(
    input.password,
    educator?.passwordHash ?? (await getDecoyHash()),
  );

  if (!educator || !verified) return settle(FAILURE);

  return settle({
    ok: true,
    educator,
    session: createSession(db, { ownerKind: "educator", ownerId: educator.id }),
  });
}

/**
 * Serialize the throttle's read/verify/record interval per username digest.
 *
 * `digestFailureDelayMs` counts committed rows, and the argon2id verify between
 * that count and `recordDigestAttempt` is a real yield point. Without this,
 * sign-in attempts that overlap on one username all observe the same pre-burst
 * count, so a parallel burst shares a single stale delay instead of each attempt
 * earning the next step of the progression — parallelism, not patience, would be
 * the way past the limiter.
 *
 * Process-local is the exact granularity: the instance is one server over one
 * SQLite file. Keying on the digest means different usernames never contend, and
 * the held interval is bounded by the login duration floor plus one verify — the
 * penalty itself is served outside, so the lock cannot become a lockout of the
 * one credential with no in-app recovery (§7).
 *
 * The chain is dropped once nothing is queued behind it, so the map stays the
 * size of the concurrent attempts rather than of every username ever submitted.
 */
const signInChains = new Map<string, Promise<void>>();

function withDigestLock<T>(digest: string, run: () => Promise<T>): Promise<T> {
  const previous = signInChains.get(digest) ?? Promise.resolve();
  const current = previous.then(run);

  // The stored tail never rejects, so one failed attempt cannot wedge the queue.
  const tail = current.then(
    () => undefined,
    () => undefined,
  );
  signInChains.set(digest, tail);
  void tail.then(() => {
    if (signInChains.get(digest) === tail) signInChains.delete(digest);
  });

  return current;
}

/**
 * Verify the operator credential with the same throttling the other
 * educator-credential paths carry (§7).
 *
 * `attemptEducatorLogin` is the pure decision and is shared with the first-run
 * "lost the token" recovery, which brings its own, separately-namespaced
 * limiter. Normal sign-in is throttled here instead, keyed per username digest
 * and per IP on the shared SQLite limiter: the operator account is the one
 * privileged credential for the whole instance and has no in-app recovery, so
 * unlimited online guessing must not be possible. A blocked attempt is refused
 * before the credential is touched and is not recorded; every branch is held to
 * the login duration floor plus any progressive delay so timing discloses
 * nothing (§7, §21).
 *
 * Counting, verifying and recording are serialized per username digest, because
 * a progressive delay is only progressive if each attempt sees the one before it
 * (see `withDigestLock`).
 */
export async function attemptEducatorSignIn(
  db: AppDatabase,
  input: { username: string; password: string; now?: Date },
): Promise<EducatorLoginResult> {
  const startedAt = Date.now();
  const settleFloor = async (
    result: EducatorLoginResult,
    extraDelayMs = 0,
  ): Promise<EducatorLoginResult> => {
    const remaining = EDUCATOR_LOGIN_MINIMUM_DURATION_MS + extraDelayMs - (Date.now() - startedAt);
    if (remaining > 0) await sleep(remaining);
    return result;
  };

  const digest = educatorRateLimitKey(input.username);

  // Only the count/verify/record interval is held. The progressive delay is
  // served after the lock is released, so a burst cannot park the operator
  // behind a minute of someone else's penalty.
  const { result, delayMs } = await withDigestLock(digest, async () => {
    const earned = digestFailureDelayMs(db, { digest, now: input.now });

    const attempt = await attemptEducatorLogin(db, {
      username: input.username,
      password: input.password,
    });
    recordDigestAttempt(db, { digest, successful: attempt.ok });

    return { result: attempt, delayMs: earned };
  });

  if (!result.ok) return settleFloor(FAILURE, delayMs);
  return result;
}

/**
 * Resolve a cookie token to a live educator, sliding the 7-day expiry (§7).
 *
 * Returns null for every failure mode — unknown, expired, invalidated, or a
 * session belonging to a student — because the caller's response is identical in
 * all of them.
 */
export function resolveEducatorSession(
  db: AppDatabase,
  token: string,
  now: Date = new Date(),
): Educator | null {
  const session = findSessionByDigest(db, hashSessionToken(token));

  if (session?.ownerKind !== "educator") return null;
  if (session.invalidatedAt !== null) return null;
  if (session.expiresAt.getTime() <= now.getTime()) return null;

  const educator = getEducatorById(db, session.ownerId);
  if (!educator) return null;

  touchSession(db, {
    sessionId: session.id,
    lastSeenAt: now,
    expiresAt: new Date(now.getTime() + EDUCATOR_SESSION_TTL_DAYS * MS_PER_DAY),
  });

  return educator;
}
