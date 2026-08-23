import type { AppDatabase } from "../db/client";
import { createEducator, findEducatorByUsername, getEducatorById } from "../db/queries/educators";
import { findSessionByDigest, touchSession } from "../db/queries/sessions";
import type { Educator } from "../db/schema";
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

  const passwordHash = await Bun.password.hash(input.password, { algorithm: "argon2id" });
  return { seeded: true, educator: createEducator(db, { username: input.username, passwordHash }) };
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
