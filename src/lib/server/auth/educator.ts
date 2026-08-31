import { and, asc, desc, eq, isNull, ne } from "drizzle-orm";
import type { AppDatabase } from "../db/client";
import {
  createEducator,
  findEducatorByUsername,
  getEducatorById,
  getFirstEducator,
  updateEducatorCredential,
} from "../db/queries/educators";
import { findSessionByDigest, touchSession } from "../db/queries/sessions";
import { type Educator, educator as educatorTable, session as sessionTable } from "../db/schema";
import { hashEducatorPassword, matchesConfiguredEducatorSeed } from "./credentials";
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
 * expiry. Credential recovery is operator-assisted and never runs in the web
 * application.
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

export { hashEducatorPassword } from "./credentials";

export interface SeedEducatorResult {
  readonly seeded: boolean;
  readonly educator: Educator;
}

/**
 * Create or update the operator account from deployment configuration.
 *
 * Updating the configured pair and restarting remains a supported recovery
 * path. The existing row is updated in place even when the username changes,
 * preserving the single-educator invariant.
 *
 * The stored hash is salted, so an unchanged password still hashes to a new
 * value — comparing hashes cannot detect a no-op. Verifying can, and leaving the
 * row untouched keeps a restart from churning it.
 */
export async function seedEducator(
  db: AppDatabase,
  input: { username: string; password: string },
): Promise<SeedEducatorResult> {
  reconcileLegacyEducators(db, input.username);

  for (;;) {
    const existing = getFirstEducator(db);

    if (
      existing?.supersededSeedHash &&
      (await matchesConfiguredEducatorSeed(input, existing.supersededSeedHash))
    ) {
      const unchanged = db.transaction(
        (tx) => {
          const current = tx
            .select()
            .from(educatorTable)
            .orderBy(asc(educatorTable.createdAt))
            .get();
          return current && sameEducatorState(current, existing)
            ? { seeded: false as const, educator: current }
            : null;
        },
        { behavior: "immediate" },
      );
      if (unchanged) return unchanged;
      continue;
    }

    const credentialMatches =
      existing?.username === input.username &&
      (await Bun.password.verify(input.password, existing.passwordHash));
    const passwordHash = credentialMatches
      ? existing.passwordHash
      : await hashEducatorPassword(input.password);

    const result = db.transaction(
      (tx): SeedEducatorResult | null => {
        const current = tx.select().from(educatorTable).orderBy(asc(educatorTable.createdAt)).get();
        if (!sameEducatorState(current, existing)) return null;

        if (!current) {
          const created = tx
            .insert(educatorTable)
            .values({ username: input.username, passwordHash })
            .returning()
            .get();
          return { seeded: true, educator: created };
        }

        if (credentialMatches) {
          if (current.supersededSeedHash === null) {
            return { seeded: false, educator: current };
          }

          const cleared = tx
            .update(educatorTable)
            .set({ supersededSeedHash: null, updatedAt: new Date() })
            .where(eq(educatorTable.id, current.id))
            .returning()
            .get();
          return { seeded: false, educator: cleared };
        }

        const now = new Date();
        const updated = tx
          .update(educatorTable)
          .set({
            username: input.username,
            passwordHash,
            supersededSeedHash: null,
            updatedAt: now,
          })
          .where(eq(educatorTable.id, current.id))
          .returning()
          .get();

        tx.update(sessionTable)
          .set({ invalidatedAt: now })
          .where(and(eq(sessionTable.ownerKind, "educator"), isNull(sessionTable.invalidatedAt)))
          .run();

        return { seeded: true, educator: updated };
      },
      { behavior: "immediate" },
    );

    if (result) return result;
  }
}

/** Collapse rows created by the old username-keyed seeding behavior. */
function reconcileLegacyEducators(db: AppDatabase, configuredUsername: string): void {
  db.transaction(
    (tx) => {
      const accounts = tx
        .select()
        .from(educatorTable)
        .orderBy(
          desc(educatorTable.updatedAt),
          desc(educatorTable.createdAt),
          asc(educatorTable.id),
        )
        .all();
      if (accounts.length <= 1) return;

      const current =
        accounts.find((account) => account.username === configuredUsername) ?? accounts[0];

      const now = new Date();
      tx.delete(educatorTable).where(ne(educatorTable.id, current.id)).run();
      tx.update(sessionTable)
        .set({ invalidatedAt: now })
        .where(and(eq(sessionTable.ownerKind, "educator"), isNull(sessionTable.invalidatedAt)))
        .run();
    },
    { behavior: "immediate" },
  );
}

function sameEducatorState(left: Educator | undefined, right: Educator | undefined): boolean {
  if (!left || !right) return left === right;
  return (
    left.id === right.id &&
    left.username === right.username &&
    left.passwordHash === right.passwordHash &&
    left.supersededSeedHash === right.supersededSeedHash
  );
}

/**
 * Create or replace *the* operator account — the first-run wizard's first step
 * (PRD §6.2, §7).
 *
 * The wizard's account step is re-runnable, and an operator who goes back and
 * corrects a typo in the username must end up with one account, not two. So an
 * existing row is updated in place and only an empty table is inserted into (§7).
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

  const authenticated = db.transaction(
    (tx): EducatorLoginResult => {
      const current = tx
        .select()
        .from(educatorTable)
        .where(eq(educatorTable.id, educator.id))
        .get();

      // Recovery may have replaced the hash while Argon2id verification was in
      // flight. Requiring the exact verified state inside the session insert's
      // transaction makes reset and login serialize in the safe order.
      if (
        !current ||
        current.username !== educator.username ||
        current.passwordHash !== educator.passwordHash
      ) {
        return FAILURE;
      }

      return {
        ok: true,
        educator: current,
        session: createSession(tx, { ownerKind: "educator", ownerId: current.id }),
      };
    },
    { behavior: "immediate" },
  );

  return settle(authenticated);
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
