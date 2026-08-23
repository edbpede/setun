import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import type { AppDatabase } from "../db/client";
import { createClassroom } from "../db/queries/classrooms";
import { getStudentById } from "../db/queries/students";
import { student as studentTable } from "../db/schema";
import { createTestDatabase } from "../db/testing";
import { generateCode } from "./codes";
import { attemptStudentLogin, LOGIN_MINIMUM_DURATION_MS } from "./login";
import { provisionStudent, rotateStudentCredential } from "./provisioning";
import { IP_ATTEMPT_LIMIT, recordAttempt } from "./rate-limit";
import { resolveStudentSession } from "./sessions";

/**
 * Login, credential lifecycle and session invalidation
 * (plan 1.3, PRD §7, §21; §22 security coverage).
 */

const PEPPER = "test-pepper-not-a-real-secret";
const IP = "203.0.113.7";

let db: AppDatabase;
let classroomId: string;

beforeEach(() => {
  db = createTestDatabase();
  classroomId = createClassroom(db, { name: "7.B" }).id;
});

const provision = () => provisionStudent(db, { classroomId, pepper: PEPPER });

describe("attemptStudentLogin", () => {
  it("authenticates a provisioned code and issues a session", async () => {
    const { student, code } = await provision();

    const result = await attemptStudentLogin(db, {
      code: code.normalised,
      ip: IP,
      pepper: PEPPER,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.student.id).toBe(student.id);
    expect(result.session.token).toBeTruthy();
  });

  it("accepts the grouped display form the student reads off the card", async () => {
    const { code } = await provision();

    expect((await attemptStudentLogin(db, { code: code.display, ip: IP, pepper: PEPPER })).ok).toBe(
      true,
    );
  });

  it("rejects an unknown code", async () => {
    await provision();

    const result = await attemptStudentLogin(db, {
      code: generateCode().normalised,
      ip: IP,
      pepper: PEPPER,
    });

    expect(result.ok).toBe(false);
  });

  it("rejects a valid code under the wrong pepper", async () => {
    const { code } = await provision();

    const result = await attemptStudentLogin(db, {
      code: code.normalised,
      ip: IP,
      pepper: "a-different-pepper",
    });

    expect(result.ok).toBe(false);
  });

  it("rejects a disabled student's valid code", async () => {
    const { student, code } = await provision();
    db.update(studentTable)
      .set({ status: "disabled" })
      .where(eq(studentTable.id, student.id))
      .run();

    const result = await attemptStudentLogin(db, {
      code: code.normalised,
      ip: IP,
      pepper: PEPPER,
    });

    expect(result.ok).toBe(false);
  });

  it("returns an identical failure shape for unknown, malformed and disabled codes", async () => {
    const { student, code } = await provision();
    db.update(studentTable)
      .set({ status: "disabled" })
      .where(eq(studentTable.id, student.id))
      .run();

    const outcomes = [
      await attemptStudentLogin(db, { code: generateCode().normalised, ip: IP, pepper: PEPPER }),
      await attemptStudentLogin(db, { code: "not-a-code", ip: IP, pepper: PEPPER }),
      await attemptStudentLogin(db, { code: "", ip: IP, pepper: PEPPER }),
      await attemptStudentLogin(db, { code: code.normalised, ip: IP, pepper: PEPPER }),
    ];

    // Nothing in the result distinguishes "no such code" from "code exists but
    // is disabled" — the route has no branch to leak (§7, §21).
    for (const outcome of outcomes) {
      expect(outcome).toEqual({ ok: false });
      expect(Object.keys(outcome)).toEqual(["ok"]);
    }
  });

  it("holds every attempt to the same minimum duration, hit or miss", async () => {
    const { code } = await provision();

    const timeOf = async (submitted: string) => {
      const startedAt = performance.now();
      await attemptStudentLogin(db, { code: submitted, ip: IP, pepper: PEPPER });
      return performance.now() - startedAt;
    };

    const miss = await timeOf(generateCode().normalised);
    const hit = await timeOf(code.normalised);

    expect(miss).toBeGreaterThanOrEqual(LOGIN_MINIMUM_DURATION_MS - 5);
    expect(hit).toBeGreaterThanOrEqual(LOGIN_MINIMUM_DURATION_MS - 5);
  });

  it("refuses once the IP window is exhausted, even with the correct code", async () => {
    const { code } = await provision();
    for (let i = 0; i < IP_ATTEMPT_LIMIT; i++) {
      recordAttempt(db, { ip: IP, digest: "unrelated", successful: false });
    }

    const result = await attemptStudentLogin(db, {
      code: code.normalised,
      ip: IP,
      pepper: PEPPER,
    });

    expect(result.ok).toBe(false);
  });

  it("records both rate-limit axes for a failed attempt", async () => {
    await attemptStudentLogin(db, { code: generateCode().normalised, ip: IP, pepper: PEPPER });

    const rows = db.$client.query("SELECT scope, successful FROM login_attempt").all() as {
      scope: string;
      successful: number;
    }[];

    expect(rows.map((r) => r.scope).sort()).toEqual(["digest", "ip"]);
    expect(rows.every((r) => r.successful === 0)).toBe(true);
  });
});

describe("credential storage", () => {
  it("never persists the plaintext code anywhere in the database", async () => {
    const { code } = await provision();

    // Scan every value of every table rather than the student row alone: the
    // claim is that the plaintext exists nowhere, not merely where expected.
    const raw = db.$client as Database;
    const tables = raw.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
      name: string;
    }[];

    for (const { name } of tables) {
      const rows = raw.query(`SELECT * FROM "${name}"`).all() as Record<string, unknown>[];
      const serialised = JSON.stringify(rows).toUpperCase();

      expect(serialised).not.toContain(code.normalised);
      expect(serialised).not.toContain(code.display);
    }
  });

  it("stores a digest and a hint that is only the code's short tail", async () => {
    const { student, code } = await provision();
    const stored = getStudentById(db, student.id);

    expect(stored?.credentialDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(stored?.credentialHint).toBe(code.hint);
    expect(code.normalised.endsWith(stored?.credentialHint ?? "")).toBe(true);
  });

  it("gives two students in one classroom distinct labels and digests", async () => {
    const first = await provision();
    const second = await provision();

    expect(first.student.label).not.toBe(second.student.label);
    expect(first.student.credentialDigest).not.toBe(second.student.credentialDigest);
  });
});

describe("rotation", () => {
  it("invalidates existing sessions immediately", async () => {
    const { student, code } = await provision();
    const login = await attemptStudentLogin(db, {
      code: code.normalised,
      ip: IP,
      pepper: PEPPER,
    });
    expect(login.ok).toBe(true);
    if (!login.ok) return;

    expect(resolveStudentSession(db, login.session.token)).not.toBeNull();

    await rotateStudentCredential(db, { studentId: student.id, pepper: PEPPER });

    // The old cookie stops working on the next request, not at expiry (§7, §21).
    expect(resolveStudentSession(db, login.session.token)).toBeNull();
  });

  it("retires the old code and accepts the new one", async () => {
    const { student, code } = await provision();

    const rotated = await rotateStudentCredential(db, { studentId: student.id, pepper: PEPPER });

    expect(
      (await attemptStudentLogin(db, { code: code.normalised, ip: IP, pepper: PEPPER })).ok,
    ).toBe(false);
    expect(
      (await attemptStudentLogin(db, { code: rotated.normalised, ip: IP, pepper: PEPPER })).ok,
    ).toBe(true);
  });
});
