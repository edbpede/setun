import { and, eq, isNull } from "drizzle-orm";
import type { AppDatabase } from "../db/client";
import { educator, session } from "../db/schema";
import { hashConfiguredEducatorSeed, hashEducatorPassword } from "./credentials";

export type EducatorRecoveryFailure = "no_educator" | "multiple_educators";

export class EducatorRecoveryError extends Error {
  constructor(readonly reason: EducatorRecoveryFailure) {
    super(reason);
    this.name = "EducatorRecoveryError";
  }
}

export interface EducatorRecoveryResult {
  readonly invalidatedSessions: number;
}

/** A 256-bit password suitable for selecting and pasting from a terminal. */
export function generateEducatorPassword(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
}

/**
 * Replace the only educator credential and revoke the educator role atomically.
 *
 * Hashing deliberately happens before the transaction: Argon2id is slow by
 * design, while the write lock should be held only for the three short writes.
 * `immediate` takes the writer reservation up front and honours the connection's
 * busy timeout rather than changing half the state before discovering contention.
 */
export async function recoverEducatorCredential(
  db: AppDatabase,
  input: {
    username: string;
    password: string;
    configuredSeed?: { username: string; password: string };
  },
): Promise<EducatorRecoveryResult> {
  const passwordHash = await hashEducatorPassword(input.password);
  const supersededSeedHash = input.configuredSeed
    ? await hashConfiguredEducatorSeed(input.configuredSeed)
    : null;

  return db.transaction(
    (tx) => {
      const accounts = tx.select().from(educator).limit(2).all();
      if (accounts.length === 0) throw new EducatorRecoveryError("no_educator");
      if (accounts.length !== 1) throw new EducatorRecoveryError("multiple_educators");

      const account = accounts[0];
      tx.update(educator)
        .set({
          username: input.username,
          passwordHash,
          supersededSeedHash,
          updatedAt: new Date(),
        })
        .where(eq(educator.id, account.id))
        .run();

      const invalidated = tx
        .update(session)
        .set({ invalidatedAt: new Date() })
        .where(and(eq(session.ownerKind, "educator"), isNull(session.invalidatedAt)))
        .returning({ id: session.id })
        .all();

      return { invalidatedSessions: invalidated.length };
    },
    { behavior: "immediate" },
  );
}
