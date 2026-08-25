import { pruneAttemptsBefore } from "../../src/lib/server/auth/rate-limit";
import { openE2eDatabase } from "./database";

/**
 * Empty the login-attempt table.
 *
 * See `login-window.ts` for why an end-to-end run needs this. Runs as a separate
 * process against the same SQLite file; WAL mode makes the concurrent write safe.
 */
const databasePath = process.env.SETUN_DATABASE_PATH;
if (!databasePath) {
  console.error("SETUN_DATABASE_PATH is required");
  process.exit(1);
}

const db = await openE2eDatabase(databasePath);

// Everything up to now: the limiter's whole memory is the window it can see.
pruneAttemptsBefore(db, new Date(Date.now() + 1_000));

console.log(JSON.stringify({ cleared: true }));
