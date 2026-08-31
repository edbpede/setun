import { beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import type { AppDatabase } from "../db/client";
import { createDatabase } from "../db/client";
import { applyMigrations } from "../db/migrate";
import { createClassroom, getClassroom } from "../db/queries/classrooms";
import { createStudent, getStudentById } from "../db/queries/students";
import { educator, session } from "../db/schema";
import { createTestDatabase } from "../db/testing";
import { attemptEducatorLogin, resolveEducatorSession, seedEducator } from "./educator";
import { generateEducatorPassword, recoverEducatorCredential } from "./recovery";
import { createSession, resolveStudentSession } from "./sessions";

const OLD_USERNAME = "old-educator";
const OLD_PASSWORD = "old-password-long-enough";
const NEW_USERNAME = "new-educator";
const NEW_PASSWORD = "new-password-long-enough";

let db: AppDatabase;

beforeEach(async () => {
  db = createTestDatabase();
  await seedEducator(db, { username: OLD_USERNAME, password: OLD_PASSWORD });
});

describe("recoverEducatorCredential", () => {
  it("updates the existing row in place and stores only an Argon2id hash", async () => {
    await recoverEducatorCredential(db, {
      username: NEW_USERNAME,
      password: NEW_PASSWORD,
    });

    const rows = db.select().from(educator).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].username).toBe(NEW_USERNAME);
    expect(rows[0].passwordHash).toStartWith("$argon2id$");
    expect(rows[0].passwordHash).not.toContain(NEW_PASSWORD);
    expect(JSON.stringify(db.$client.query("SELECT * FROM educator").all())).not.toContain(
      NEW_PASSWORD,
    );
  });

  it("refuses the old credential and accepts the new one", async () => {
    await recoverEducatorCredential(db, {
      username: NEW_USERNAME,
      password: NEW_PASSWORD,
    });

    expect(
      (await attemptEducatorLogin(db, { username: OLD_USERNAME, password: OLD_PASSWORD })).ok,
    ).toBe(false);
    expect(
      (await attemptEducatorLogin(db, { username: NEW_USERNAME, password: NEW_PASSWORD })).ok,
    ).toBe(true);
  });

  it("collapses legacy educator rows during recovery", async () => {
    db.insert(educator)
      .values({
        username: "newer-legacy-educator",
        passwordHash: await Bun.password.hash("newer-legacy-password", {
          algorithm: "argon2id",
        }),
        createdAt: new Date(Date.now() + 1_000),
        updatedAt: new Date(Date.now() + 1_000),
      })
      .run();

    await recoverEducatorCredential(db, {
      username: NEW_USERNAME,
      password: NEW_PASSWORD,
    });

    const accounts = db.select().from(educator).all();
    expect(accounts).toHaveLength(1);
    expect(accounts[0].username).toBe(NEW_USERNAME);
  });

  it("invalidates every educator session and preserves student state", async () => {
    const account = db.select().from(educator).get();
    if (!account) throw new Error("expected an educator");

    const classroom = createClassroom(db, { name: "7.B" });
    const student = createStudent(db, {
      classroomId: classroom.id,
      label: "brave-otter",
      credentialDigest: "student-digest",
      credentialHint: "ABCD",
    });
    const firstEducator = createSession(db, { ownerKind: "educator", ownerId: account.id });
    const secondEducator = createSession(db, { ownerKind: "educator", ownerId: account.id });
    const studentSession = createSession(db, { ownerKind: "student", ownerId: student.id });

    const result = await recoverEducatorCredential(db, {
      username: NEW_USERNAME,
      password: NEW_PASSWORD,
    });

    expect(result.invalidatedSessions).toBe(2);
    expect(resolveEducatorSession(db, firstEducator.token)).toBeNull();
    expect(resolveEducatorSession(db, secondEducator.token)).toBeNull();
    expect(resolveStudentSession(db, studentSession.token)?.student.id).toBe(student.id);
    expect(getClassroom(db, classroom.id)?.name).toBe("7.B");
    expect(getStudentById(db, student.id)?.label).toBe("brave-otter");
  });

  it("rolls the credential back when session invalidation fails", async () => {
    const account = db.select().from(educator).get();
    if (!account) throw new Error("expected an educator");
    const educatorSession = createSession(db, { ownerKind: "educator", ownerId: account.id });

    db.$client.exec(`
      CREATE TRIGGER fail_recovery_session_update
      BEFORE UPDATE OF invalidatedAt ON session
      WHEN OLD.ownerKind = 'educator' AND NEW.invalidatedAt IS NOT NULL
      BEGIN
        SELECT RAISE(ABORT, 'forced recovery failure');
      END;
    `);

    await expect(
      recoverEducatorCredential(db, { username: NEW_USERNAME, password: NEW_PASSWORD }),
    ).rejects.toThrow();

    const unchanged = db.select().from(educator).get();
    expect(unchanged?.username).toBe(OLD_USERNAME);
    expect(await Bun.password.verify(OLD_PASSWORD, unchanged?.passwordHash ?? "")).toBe(true);
    expect(
      db.select().from(session).where(eq(session.id, educatorSession.session.id)).get()
        ?.invalidatedAt,
    ).toBeNull();
  });

  it("works through a second WAL connection while the application connection stays open", async () => {
    const root = mkdtempSync(join(tmpdir(), "setun-recovery-"));
    const path = join(root, "setun.sqlite");
    let applicationDb: AppDatabase | undefined;
    let recoveryDb: AppDatabase | undefined;

    try {
      applicationDb = createDatabase(path);
      applyMigrations(applicationDb);
      await seedEducator(applicationDb, { username: OLD_USERNAME, password: OLD_PASSWORD });

      recoveryDb = createDatabase(path);
      await recoverEducatorCredential(recoveryDb, {
        username: NEW_USERNAME,
        password: NEW_PASSWORD,
      });

      const login = await attemptEducatorLogin(applicationDb, {
        username: NEW_USERNAME,
        password: NEW_PASSWORD,
      });
      expect(login.ok).toBe(true);
    } finally {
      recoveryDb?.$client.close();
      applicationDb?.$client.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("boot-time educator seed reconciliation", () => {
  it("does not let an unchanged seed undo a successful recovery", async () => {
    await recoverEducatorCredential(db, {
      username: NEW_USERNAME,
      password: NEW_PASSWORD,
      configuredSeed: { username: OLD_USERNAME, password: OLD_PASSWORD },
    });

    const recovered = db.select().from(educator).get();
    expect(recovered?.supersededSeedHash).toStartWith("$argon2id$");
    expect(recovered?.supersededSeedHash).not.toContain(OLD_USERNAME);
    expect(recovered?.supersededSeedHash).not.toContain(OLD_PASSWORD);

    const reseeded = await seedEducator(db, { username: OLD_USERNAME, password: OLD_PASSWORD });

    expect(reseeded.seeded).toBe(false);
    expect(reseeded.educator.username).toBe(NEW_USERNAME);
    expect(await Bun.password.verify(NEW_PASSWORD, reseeded.educator.passwordHash)).toBe(true);
    expect(db.select().from(educator).all()).toHaveLength(1);
  });

  it("preserves the superseded seed marker across seedless recovery", async () => {
    await recoverEducatorCredential(db, {
      username: NEW_USERNAME,
      password: NEW_PASSWORD,
      configuredSeed: { username: OLD_USERNAME, password: OLD_PASSWORD },
    });
    const marker = db.select().from(educator).get()?.supersededSeedHash;

    await recoverEducatorCredential(db, {
      username: "second-recovery",
      password: "second-recovery-password",
    });

    expect(db.select().from(educator).get()?.supersededSeedHash).toBe(marker);
    const reseeded = await seedEducator(db, { username: OLD_USERNAME, password: OLD_PASSWORD });
    expect(reseeded.seeded).toBe(false);
    expect(reseeded.educator.username).toBe("second-recovery");
  });

  it("keeps changed deployment seeds as a supported recovery path", async () => {
    await recoverEducatorCredential(db, {
      username: NEW_USERNAME,
      password: NEW_PASSWORD,
      configuredSeed: { username: OLD_USERNAME, password: OLD_PASSWORD },
    });
    const recovered = db.select().from(educator).get();
    if (!recovered) throw new Error("expected an educator");
    const recoveredSession = createSession(db, {
      ownerKind: "educator",
      ownerId: recovered.id,
    });

    const seeded = await seedEducator(db, {
      username: "configured-educator",
      password: "configured-password-long-enough",
    });

    expect(seeded.seeded).toBe(true);
    expect(seeded.educator.username).toBe("configured-educator");
    expect(seeded.educator.supersededSeedHash).toBeNull();
    expect(resolveEducatorSession(db, recoveredSession.token)).toBeNull();
    expect(db.select().from(educator).all()).toHaveLength(1);
  });
});

describe("generateEducatorPassword", () => {
  it("generates a unique 256-bit base64url value", () => {
    const passwords = new Set(Array.from({ length: 100 }, generateEducatorPassword));
    expect(passwords.size).toBe(100);
    for (const password of passwords) expect(password).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});
