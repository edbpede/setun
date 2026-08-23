import { beforeEach, describe, expect, it } from "bun:test";
import type { AppDatabase } from "../db/client";
import { createTestDatabase } from "../db/testing";
import {
  checkRateLimit,
  DIGEST_BASE_DELAY_MS,
  DIGEST_FAILURE_THRESHOLD,
  DIGEST_MAX_DELAY_MS,
  delayForFailures,
  IP_ATTEMPT_LIMIT,
  recordAttempt,
} from "./rate-limit";

/**
 * Rate-limiter thresholds and progression (plan 1.3, PRD §7, Appendix A, §22).
 */

let db: AppDatabase;

beforeEach(() => {
  db = createTestDatabase();
});

const IP = "203.0.113.7";
const DIGEST = "a".repeat(64);

function fail(times: number, over: { ip?: string; digest?: string } = {}) {
  for (let i = 0; i < times; i++) {
    recordAttempt(db, {
      ip: over.ip ?? IP,
      digest: over.digest ?? DIGEST,
      successful: false,
    });
  }
}

describe("delayForFailures", () => {
  it("does not delay below the Appendix A threshold of 5 failures", () => {
    for (let failures = 0; failures < DIGEST_FAILURE_THRESHOLD; failures++) {
      expect(delayForFailures(failures)).toBe(0);
    }
  });

  it("starts at 1 s on the threshold and doubles from there", () => {
    expect(delayForFailures(DIGEST_FAILURE_THRESHOLD)).toBe(DIGEST_BASE_DELAY_MS);
    expect(delayForFailures(DIGEST_FAILURE_THRESHOLD + 1)).toBe(DIGEST_BASE_DELAY_MS * 2);
    expect(delayForFailures(DIGEST_FAILURE_THRESHOLD + 2)).toBe(DIGEST_BASE_DELAY_MS * 4);
  });

  it("never exceeds the 60 s ceiling", () => {
    expect(delayForFailures(DIGEST_FAILURE_THRESHOLD + 20)).toBe(DIGEST_MAX_DELAY_MS);
    expect(delayForFailures(1_000)).toBe(DIGEST_MAX_DELAY_MS);
  });
});

describe("checkRateLimit — per digest", () => {
  it("permits an untouched digest without delay", () => {
    expect(checkRateLimit(db, { ip: IP, digest: DIGEST })).toEqual({
      blocked: false,
      delayMs: 0,
    });
  });

  it("applies progressive delay once consecutive failures reach the threshold", () => {
    fail(DIGEST_FAILURE_THRESHOLD);

    expect(checkRateLimit(db, { ip: IP, digest: DIGEST }).delayMs).toBe(DIGEST_BASE_DELAY_MS);
  });

  it("resets the progression after a success", () => {
    fail(DIGEST_FAILURE_THRESHOLD + 2);
    expect(checkRateLimit(db, { ip: IP, digest: DIGEST }).delayMs).toBeGreaterThan(0);

    recordAttempt(db, { ip: IP, digest: DIGEST, successful: true });

    expect(checkRateLimit(db, { ip: IP, digest: DIGEST }).delayMs).toBe(0);
  });

  it("throttles each digest independently", () => {
    fail(DIGEST_FAILURE_THRESHOLD);
    const other = "b".repeat(64);

    expect(checkRateLimit(db, { ip: IP, digest: other }).delayMs).toBe(0);
  });

  it("ignores failures older than the 15-minute window", () => {
    fail(DIGEST_FAILURE_THRESHOLD);
    const laterThanWindow = new Date(Date.now() + 16 * 60 * 1000);

    expect(checkRateLimit(db, { ip: IP, digest: DIGEST, now: laterThanWindow }).delayMs).toBe(0);
  });
});

describe("checkRateLimit — per IP", () => {
  it("blocks outright at 30 attempts in the window", () => {
    fail(IP_ATTEMPT_LIMIT);

    expect(checkRateLimit(db, { ip: IP, digest: DIGEST }).blocked).toBe(true);
  });

  it("permits the attempt immediately below the limit", () => {
    fail(IP_ATTEMPT_LIMIT - 1);

    expect(checkRateLimit(db, { ip: IP, digest: DIGEST }).blocked).toBe(false);
  });

  it("counts successful attempts toward the IP limit too", () => {
    for (let i = 0; i < IP_ATTEMPT_LIMIT; i++) {
      recordAttempt(db, { ip: IP, digest: DIGEST, successful: true });
    }

    expect(checkRateLimit(db, { ip: IP, digest: DIGEST }).blocked).toBe(true);
  });

  it("blocks each IP independently", () => {
    fail(IP_ATTEMPT_LIMIT);

    expect(checkRateLimit(db, { ip: "198.51.100.9", digest: DIGEST }).blocked).toBe(false);
  });

  it("releases the block once the window passes", () => {
    fail(IP_ATTEMPT_LIMIT);
    const laterThanWindow = new Date(Date.now() + 16 * 60 * 1000);

    expect(checkRateLimit(db, { ip: IP, digest: DIGEST, now: laterThanWindow }).blocked).toBe(
      false,
    );
  });
});
