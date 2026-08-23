import { integer, text } from "drizzle-orm/sqlite-core";

/**
 * Column primitives shared by every aggregate.
 *
 * Identifiers are opaque random UUIDs rather than sequence numbers: they appear
 * in URLs and SSE payloads, and a guessable identifier is an invitation to probe
 * another student's data (PRD §21).
 */
export const primaryId = () =>
  text()
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID());

/** Milliseconds since the epoch, surfaced as a `Date`. UTC storage; classroom-timezone arithmetic happens above the database (§10). */
export const createdAt = () =>
  integer({ mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date());

export const updatedAt = () =>
  integer({ mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date())
    .$onUpdateFn(() => new Date());
