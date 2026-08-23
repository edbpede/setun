import { beforeEach, describe, expect, it } from "bun:test";
import type { AppDatabase } from "../db/client";
import { createClassroom } from "../db/queries/classrooms";
import { createStudent } from "../db/queries/students";
import { createTestDatabase } from "../db/testing";
import {
  attemptEducatorLogin,
  EDUCATOR_LOGIN_MINIMUM_DURATION_MS,
  resolveEducatorSession,
  seedEducator,
} from "./educator";
import {
  createSession,
  EDUCATOR_SESSION_TTL_DAYS,
  invalidateAllSessionsFor,
  resolveStudentSession,
} from "./sessions";

/**
 * Educator authentication (plan 2.1, PRD §7, §21, §22).
 *
 * The security property under test is role separation: a student session must
 * never satisfy an educator check, and an educator session must never resolve as
 * a student (§21, §22).
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const USERNAME = "laerer";
const PASSWORD = "a-long-operator-password";

let db: AppDatabase;

beforeEach(() => {
  db = createTestDatabase();
});

describe("seedEducator", () => {
  it("creates the account from deployment configuration", async () => {
    const result = await seedEducator(db, { username: USERNAME, password: PASSWORD });

    expect(result.seeded).toBe(true);
    expect(result.educator.username).toBe(USERNAME);
  });

  it("hashes with argon2id and never stores the plaintext", async () => {
    const { educator } = await seedEducator(db, { username: USERNAME, password: PASSWORD });

    expect(educator.passwordHash).toStartWith("$argon2id$");
    expect(educator.passwordHash).not.toContain(PASSWORD);

    const rows = db.$client.query("SELECT * FROM educator").all();
    expect(JSON.stringify(rows)).not.toContain(PASSWORD);
  });

  it("is a no-op when the same credential is re-seeded on restart", async () => {
    const first = await seedEducator(db, { username: USERNAME, password: PASSWORD });
    const second = await seedEducator(db, { username: USERNAME, password: PASSWORD });

    expect(second.seeded).toBe(false);
    expect(second.educator.passwordHash).toBe(first.educator.passwordHash);
  });

  /** The documented recovery path: re-seed and restart (§7, §6.2). */
  it("replaces the password when the seed changes, and the old one stops working", async () => {
    await seedEducator(db, { username: USERNAME, password: PASSWORD });
    const reseeded = await seedEducator(db, { username: USERNAME, password: "a-new-password" });

    expect(reseeded.seeded).toBe(true);

    const withOld = await attemptEducatorLogin(db, { username: USERNAME, password: PASSWORD });
    expect(withOld.ok).toBe(false);

    const withNew = await attemptEducatorLogin(db, {
      username: USERNAME,
      password: "a-new-password",
    });
    expect(withNew.ok).toBe(true);
  });
});

describe("attemptEducatorLogin", () => {
  beforeEach(async () => {
    await seedEducator(db, { username: USERNAME, password: PASSWORD });
  });

  it("establishes an educator session on the correct credential", async () => {
    const result = await attemptEducatorLogin(db, { username: USERNAME, password: PASSWORD });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.session.session.ownerKind).toBe("educator");
    expect(result.session.session.ownerId).toBe(result.educator.id);
  });

  it("applies the Appendix A sliding 7-day expiry", async () => {
    const result = await attemptEducatorLogin(db, { username: USERNAME, password: PASSWORD });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const lifetime = result.session.session.expiresAt.getTime() - Date.now();
    expect(Math.round(lifetime / MS_PER_DAY)).toBe(EDUCATOR_SESSION_TTL_DAYS);
    expect(EDUCATOR_SESSION_TTL_DAYS).toBe(7);
  });

  it("refuses a wrong password and an unknown username identically", async () => {
    const wrongPassword = await attemptEducatorLogin(db, {
      username: USERNAME,
      password: "not-the-password",
    });
    const unknownUser = await attemptEducatorLogin(db, {
      username: "nobody",
      password: PASSWORD,
    });

    expect(wrongPassword).toEqual({ ok: false });
    expect(unknownUser).toEqual({ ok: false });
  });

  /** Uniform in timing as well as content (§7, §21, §22). */
  it("holds every attempt to the same duration floor", async () => {
    const time = async (username: string, password: string) => {
      const startedAt = Date.now();
      await attemptEducatorLogin(db, { username, password });
      return Date.now() - startedAt;
    };

    const unknown = await time("nobody-at-all", PASSWORD);
    const wrong = await time(USERNAME, "not-the-password");
    const correct = await time(USERNAME, PASSWORD);

    for (const duration of [unknown, wrong, correct]) {
      expect(duration).toBeGreaterThanOrEqual(EDUCATOR_LOGIN_MINIMUM_DURATION_MS - 5);
    }
    // An unknown username must not be observably cheaper than a known one — the
    // decoy hash is what keeps the argon2id work on both paths.
    expect(Math.abs(unknown - wrong)).toBeLessThan(120);
  });
});

describe("resolveEducatorSession", () => {
  beforeEach(async () => {
    await seedEducator(db, { username: USERNAME, password: PASSWORD });
  });

  const signIn = async () => {
    const result = await attemptEducatorLogin(db, { username: USERNAME, password: PASSWORD });
    if (!result.ok) throw new Error("expected the seeded credential to authenticate");
    return result;
  };

  it("resolves a live session to its educator", async () => {
    const { token } = (await signIn()).session;

    expect(resolveEducatorSession(db, token)?.username).toBe(USERNAME);
  });

  it("returns null for an unknown token", () => {
    expect(resolveEducatorSession(db, "not-a-token")).toBeNull();
  });

  it("returns null once the session has expired", async () => {
    const { token } = (await signIn()).session;
    const afterExpiry = new Date(Date.now() + (EDUCATOR_SESSION_TTL_DAYS + 1) * MS_PER_DAY);

    expect(resolveEducatorSession(db, token, afterExpiry)).toBeNull();
  });

  it("slides the expiry forward on each resolution", async () => {
    const { token, session } = (await signIn()).session;
    const later = new Date(Date.now() + 3 * MS_PER_DAY);

    resolveEducatorSession(db, token, later);

    const stored = db.$client
      .query("SELECT expiresAt FROM session WHERE id = ?")
      .get(session.id) as { expiresAt: number };
    expect(stored.expiresAt).toBe(later.getTime() + EDUCATOR_SESSION_TTL_DAYS * MS_PER_DAY);
  });

  it("is invalidated immediately by force-logout", async () => {
    const { token } = (await signIn()).session;
    const educator = resolveEducatorSession(db, token);
    if (!educator) throw new Error("expected the session to resolve");

    invalidateAllSessionsFor(db, { ownerKind: "educator", ownerId: educator.id });

    expect(resolveEducatorSession(db, token)).toBeNull();
  });
});

/**
 * Role separation (§21, §22).
 *
 * "Educator endpoints require an educator role." These assert the two
 * namespaces cannot be crossed in either direction.
 */
describe("role separation", () => {
  it("refuses to resolve a student session as an educator", () => {
    const classroom = createClassroom(db, { name: "7.B" });
    const student = createStudent(db, {
      classroomId: classroom.id,
      label: "brave-otter",
      credentialDigest: "digest-one",
      credentialHint: "ABCD",
    });
    const { token } = createSession(db, { ownerKind: "student", ownerId: student.id });

    expect(resolveEducatorSession(db, token)).toBeNull();
  });

  it("refuses to resolve an educator session as a student", async () => {
    const { educator } = await seedEducator(db, { username: USERNAME, password: PASSWORD });
    const { token } = createSession(db, { ownerKind: "educator", ownerId: educator.id });

    expect(resolveStudentSession(db, token)).toBeNull();
  });
});
