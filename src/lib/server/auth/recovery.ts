import { and, asc, desc, eq, isNull, ne } from "drizzle-orm";
import type { AppDatabase } from "../db/client";
import { educator, session } from "../db/schema";
import { hashConfiguredEducatorSeed, hashEducatorPassword } from "./credentials";

export type EducatorRecoveryFailure = "no_educator";

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
    : undefined;

  return db.transaction(
    (tx) => {
      const accounts = tx
        .select()
        .from(educator)
        .orderBy(desc(educator.updatedAt), desc(educator.createdAt), asc(educator.id))
        .all();
      if (accounts.length === 0) throw new EducatorRecoveryError("no_educator");

      const account = accounts[0];
      if (accounts.length > 1) {
        tx.delete(educator).where(ne(educator.id, account.id)).run();
      }
      tx.update(educator)
        .set({
          username: input.username,
          passwordHash,
          ...(supersededSeedHash === undefined ? {} : { supersededSeedHash }),
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
