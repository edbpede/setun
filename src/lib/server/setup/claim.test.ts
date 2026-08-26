import { beforeEach, describe, expect, it } from "bun:test";
import { BootstrapTokenHolder } from "../auth/bootstrap";
import { hashEducatorPassword } from "../auth/educator";
import { IP_ATTEMPT_LIMIT } from "../auth/rate-limit";
import { hashSessionToken } from "../auth/sessions";
import type { AppDatabase } from "../db/client";
import { createEducator } from "../db/queries/educators";
import {
  completeSetup,
  ensureInstance,
  readInstance,
  renewClaim,
  takeClaim,
} from "../db/queries/instance";
import { loginAttempt } from "../db/schema";
import { createTestDatabase } from "../db/testing";
import {
  claimExpiresAt,
  claimSetup,
  describeForeignClaim,
  holdsClaim,
  recoverClaim,
  SETUP_CLAIM_TTL_MS,
  verifyAndSlideClaim,
} from "./claim";

/**
 * The setup claim: exclusivity, its evaluation order, and its two lifetimes
 * (plan 6.1, PRD §6.2, §7, §21, §22).
 *
 * Every case here passes an explicit `now`, because the properties under test
 * are all about time: a ten-minute claim inside a fifteen-minute token, a slide
 * on each step, and a timestamp from the future treated as no claim at all.
 */

let db: AppDatabase;
let bootstrap: BootstrapTokenHolder;
let token: string;

const NOW = new Date("2026-09-01T08:00:00Z");
const IP = "203.0.113.7";

const at = (ms: number) => new Date(NOW.getTime() + ms);

beforeEach(() => {
  db = createTestDatabase();
  bootstrap = new BootstrapTokenHolder();
  token = bootstrap.mint(NOW).display;
});

function claim(over: { token?: string; proof?: string | null; ip?: string; now?: Date } = {}) {
  return claimSetup(db, {
    token: over.token ?? token,
    presentedProof: over.proof ?? null,
    ip: over.ip ?? IP,
    bootstrap,
    now: over.now ?? NOW,
  });
}

async function claimed(now: Date = NOW): Promise<string> {
  const result = await claim({ now });
  if (!result.ok) throw new Error(`expected a claim, got ${result.reason}`);
  return result.proof;
}

/**
 * Fill this address's attempt budget for the window ending at `now`.
 *
 * Written straight to the table rather than through thirty real attempts: the
 * limiter's own progression is asserted in its suite, each attempt here would
 * pay the 250 ms timing floor, and the rows have to carry a timestamp inside
 * the window the assertion's clock is looking at.
 */
function fillIpBudget(now: Date) {
  db.insert(loginAttempt)
    .values(
      Array.from({ length: IP_ATTEMPT_LIMIT }, () => ({
        scope: "ip" as const,
        key: IP,
        successful: false,
        createdAt: now,
      })),
    )
    .run();
}

async function seedEducator(password = "korrekt-hest-batteri") {
  return createEducator(db, {
    username: "laerer",
    passwordHash: await hashEducatorPassword(password),
  });
}

describe("claimSetup", () => {
  it("takes the claim with a valid token and stores only its digest", async () => {
    const proof = await claimed();
    const row = readInstance(db);

    expect(proof.length).toBeGreaterThan(30);
    expect(row?.claimProofDigest).toBe(hashSessionToken(proof));
    // The plaintext lives in the cookie and nowhere else (§21).
    expect(row?.claimProofDigest).not.toBe(proof);
    expect(row?.setupStartedAt).toEqual(NOW);
  });

  it("is idempotent for the browser that already holds it, and slides the claim", async () => {
    const proof = await claimed();

    const again = await claim({ proof, now: at(60_000) });
    expect(again).toEqual({ ok: true, proof });
    expect(readInstance(db)?.claimedAt).toEqual(at(60_000));
  });

  it("refuses a second browser with 409 and the instant the claim lapses", async () => {
    await claimed();

    const second = await claim({ now: at(60_000) });
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error("unreachable");
    expect(second.reason).toBe("setup_claimed");
    expect(second.retryAt).toEqual(at(SETUP_CLAIM_TTL_MS));
  });

  it("reopens once the claim lapses, without a restart — the token still works", async () => {
    await claimed();

    const later = await claim({ now: at(SETUP_CLAIM_TTL_MS + 1_000) });
    expect(later.ok).toBe(true);
  });

  it("answers empty, malformed, wrong and expired tokens identically", async () => {
    const cases = [
      { label: "empty", token: "", now: NOW },
      { label: "malformed", token: "not-a-token", now: NOW },
      { label: "wrong", token: "2".repeat(24), now: NOW },
      // Past the token's fifteen minutes, but not the claim's ten — a fresh
      // installation, so nothing else is in the way.
      { label: "expired", token, now: at(16 * 60_000) },
    ];

    for (const testCase of cases) {
      db = createTestDatabase();
      const result = await claim({ token: testCase.token, now: testCase.now });

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.reason).toBe("invalid_token");
      expect(result.retryAt).toBeNull();
    }
  });

  it("leaves the token usable after a wrong guess — only completion or expiry clears it", async () => {
    await claim({ token: "2".repeat(24) });

    expect((await claim({ now: at(1_000) })).ok).toBe(true);
  });

  it("refuses everything once setup is complete", async () => {
    ensureInstance(db);
    completeSetup(db, NOW);

    const result = await claim();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("setup_complete");
  });

  it("rate limits a stream of wrong tokens from one address", async () => {
    fillIpBudget(NOW);

    const result = await claim({ token: "2".repeat(24) });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("rate_limited");
  });

  it("answers 409 before 429, so a legitimate retry does not spend its budget", async () => {
    await claimed();
    fillIpBudget(at(60_000));

    const result = await claim({ now: at(60_000) });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("setup_claimed");
  });
});

describe("holdsClaim and claimExpiresAt", () => {
  it("rejects a claim timestamp in the future rather than honouring it", async () => {
    const proof = await claimed();
    // Clock skew, or a hand-edited row. Honouring it would be a denial of setup
    // that no restart clears, because the row survives one.
    renewClaim(db, at(60 * 60_000));

    const row = readInstance(db);
    expect(claimExpiresAt(row, NOW)).toBeNull();
    expect(holdsClaim(row, proof, NOW)).toBe(false);
  });

  it("treats a lapsed claim as no claim", async () => {
    await claimed();

    expect(claimExpiresAt(readInstance(db), at(SETUP_CLAIM_TTL_MS))).toBeNull();
  });

  it("degrades an unrepresentable expiry to no claim rather than throwing", () => {
    ensureInstance(db);
    takeClaim(db, {
      proofDigest: "a".repeat(64),
      // The largest instant a Date can hold; ten minutes past it is not one.
      now: new Date(8.64e15),
      staleBefore: new Date(0),
    });

    expect(() => claimExpiresAt(readInstance(db), new Date(8.64e15))).not.toThrow();
    expect(claimExpiresAt(readInstance(db), new Date(8.64e15))).toBeNull();
  });

  it("does not match a proof that is not the one held", async () => {
    await claimed();

    expect(holdsClaim(readInstance(db), "some-other-proof", NOW)).toBe(false);
    expect(holdsClaim(readInstance(db), null, NOW)).toBe(false);
  });
});

describe("verifyAndSlideClaim", () => {
  it("slides the claim forward on every guarded step", async () => {
    const proof = await claimed();

    expect(verifyAndSlideClaim(db, proof, at(9 * 60_000))).toBe(true);
    expect(readInstance(db)?.claimedAt).toEqual(at(9 * 60_000));
    // Ten minutes is the idle allowance, not the budget for finishing setup.
    expect(verifyAndSlideClaim(db, proof, at(18 * 60_000))).toBe(true);
  });

  it("refuses once the claim has lapsed, and once setup is complete", async () => {
    const proof = await claimed();
    expect(verifyAndSlideClaim(db, proof, at(SETUP_CLAIM_TTL_MS + 1))).toBe(false);

    renewClaim(db, NOW);
    completeSetup(db, NOW);
    expect(verifyAndSlideClaim(db, proof, NOW)).toBe(false);
  });
});

describe("describeForeignClaim", () => {
  it("reports a live claim this browser does not hold, with a retry time", async () => {
    await claimed();

    expect(describeForeignClaim(db, null, at(60_000))).toEqual({
      heldElsewhere: true,
      retryAt: at(SETUP_CLAIM_TTL_MS),
    });
  });

  it("reports nothing for the holder, and nothing when no claim is live", async () => {
    const proof = await claimed();

    expect(describeForeignClaim(db, proof, at(60_000))).toEqual({
      heldElsewhere: false,
      retryAt: null,
    });
    expect(describeForeignClaim(db, null, at(SETUP_CLAIM_TTL_MS))).toEqual({
      heldElsewhere: false,
      retryAt: null,
    });
  });
});

describe("recoverClaim", () => {
  const recover = (over: { username?: string; password?: string; now?: Date } = {}) =>
    recoverClaim(db, {
      username: over.username ?? "laerer",
      password: over.password ?? "korrekt-hest-batteri",
      ip: IP,
      now: over.now ?? NOW,
    });

  it("refuses before an account exists — the token is the only proof there can be", async () => {
    const result = await recover();

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("no_educator");
  });

  it("answers an unknown username and a wrong password identically", async () => {
    await seedEducator();

    const unknown = await recover({ username: "ukendt" });
    const wrong = await recover({ password: "forkert-adgangskode" });

    expect(unknown).toEqual({ ok: false, reason: "invalid_credentials", retryAt: null });
    expect(wrong).toEqual({ ok: false, reason: "invalid_credentials", retryAt: null });
  });

  it("takes a live claim over, so a lost cookie needs no restart", async () => {
    await seedEducator();
    const lost = await claimed();

    const result = await recover({ now: at(60_000) });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");

    const row = readInstance(db);
    expect(holdsClaim(row, result.proof, at(60_000))).toBe(true);
    // The browser that lost its cookie no longer owns the setup.
    expect(holdsClaim(row, lost, at(60_000))).toBe(false);
  });

  it("leaves no usable session behind — the educator's own is issued at the end", async () => {
    await seedEducator();
    const before = db.$client.query("SELECT count(*) AS n FROM session").get() as { n: number };

    expect((await recover()).ok).toBe(true);

    const rows = db.$client.query("SELECT invalidatedAt FROM session").all() as {
      invalidatedAt: number | null;
    }[];
    expect(rows.length).toBe(before.n + 1);
    expect(rows.every((row) => row.invalidatedAt !== null)).toBe(true);
  });

  it("refuses once setup is complete", async () => {
    await seedEducator();
    ensureInstance(db);
    completeSetup(db, NOW);

    const result = await recover();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("setup_complete");
  });
});
