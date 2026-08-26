import { beforeEach, describe, expect, it } from "bun:test";
import type { AppDatabase } from "../db/client";
import { createClassroom } from "../db/queries/classrooms";
import { createEducator } from "../db/queries/educators";
import {
  completeSetup,
  ensureInstance,
  readInstance,
  reopenSetup,
  takeClaim,
} from "../db/queries/instance";
import { createAlias } from "../db/queries/model-aliases";
import { createStudent } from "../db/queries/students";
import { createTestDatabase } from "../db/testing";
import {
  adoptExistingInstall,
  canFinishSetup,
  isSetupComplete,
  isSetupGateExempt,
  resolveSetupProgress,
  resolveStep,
  visibleSteps,
} from "./state";

/**
 * The gate decision, the adoption rule and the resume derivation
 * (plan 6.1, PRD §6.2, §7, §22).
 */

let db: AppDatabase;

beforeEach(() => {
  db = createTestDatabase();
});

const NOW = new Date("2026-09-01T08:00:00Z");

function seedEducatorRow() {
  return createEducator(db, { username: "laerer", passwordHash: "argon2id$not-a-real-hash" });
}

function seedAlias() {
  return createAlias(db, { name: "Balanceret", gatewayModelId: "stub", dialect: "openai" });
}

describe("isSetupGateExempt", () => {
  it("lets the wizard and its bundle through", () => {
    expect(isSetupGateExempt("/setup")).toBe(true);
    expect(isSetupGateExempt("/setup/anything")).toBe(true);
    expect(isSetupGateExempt("/_app/immutable/entry/app.js")).toBe(true);
  });

  it("lets through the files a browser and a crawler fetch unasked", () => {
    expect(isSetupGateExempt("/favicon.ico")).toBe(true);
    expect(isSetupGateExempt("/robots.txt")).toBe(true);
    expect(isSetupGateExempt("/setun-mark.svg")).toBe(true);
  });

  it("redirects everything else, including a path that merely starts like the wizard", () => {
    expect(isSetupGateExempt("/")).toBe(false);
    expect(isSetupGateExempt("/dashboard")).toBe(false);
    expect(isSetupGateExempt("/educator/login")).toBe(false);
    expect(isSetupGateExempt("/api/conversations")).toBe(false);
    // A prefix match on "/setup" alone would open this one up.
    expect(isSetupGateExempt("/setup-something-else")).toBe(false);
  });
});

describe("adoptExistingInstall", () => {
  it("does not adopt a genuinely cold installation", () => {
    expect(adoptExistingInstall(db, { educatorConfigured: false, now: NOW })).toBe(false);
    expect(isSetupComplete(db)).toBe(false);
  });

  it("adopts an installation that already has an operator account", () => {
    seedEducatorRow();

    expect(adoptExistingInstall(db, { educatorConfigured: false, now: NOW })).toBe(true);
    expect(isSetupComplete(db)).toBe(true);
  });

  it("adopts when seed credentials are configured, before the row exists", () => {
    // Seeding is asynchronous at boot, so the row is legitimately absent here.
    expect(adoptExistingInstall(db, { educatorConfigured: true, now: NOW })).toBe(true);
    expect(isSetupComplete(db)).toBe(true);
  });

  it("adopts at most once, so a restart logs nothing new", () => {
    seedEducatorRow();

    expect(adoptExistingInstall(db, { educatorConfigured: false, now: NOW })).toBe(true);
    expect(adoptExistingInstall(db, { educatorConfigured: false, now: NOW })).toBe(false);
  });

  it("never adopts an installation whose wizard has been claimed", () => {
    ensureInstance(db);
    takeClaim(db, {
      proofDigest: "a".repeat(64),
      now: NOW,
      staleBefore: new Date(NOW.getTime() - 1),
    });

    // The wizard creates the account at its first step and still has three
    // steps to go; adopting here would open the gate halfway through.
    seedEducatorRow();

    expect(adoptExistingInstall(db, { educatorConfigured: false, now: NOW })).toBe(false);
    expect(isSetupComplete(db)).toBe(false);
    expect(readInstance(db)?.setupStartedAt).toEqual(NOW);
  });
});

/**
 * Boot adopts on the strength of *configured* seed credentials, before the
 * asynchronous seed has landed. `reopenSetup` is what makes that safe to do: a
 * seed that fails takes its adoption back rather than leaving an installation
 * recorded as complete with no operator account (PRD §6.2, §7).
 */
describe("reopenSetup", () => {
  it("takes back an adoption whose seed never landed", () => {
    expect(adoptExistingInstall(db, { educatorConfigured: true, now: NOW })).toBe(true);
    expect(isSetupComplete(db)).toBe(true);

    expect(reopenSetup(db, NOW)).toBe(true);
    expect(isSetupComplete(db)).toBe(false);
    // Still adoptable, and still claimable, on the next boot.
    expect(readInstance(db)?.setupStartedAt).toBeNull();
  });

  it("refuses to reopen an installation whose wizard was actually claimed", () => {
    ensureInstance(db);
    takeClaim(db, {
      proofDigest: "not-a-real-digest",
      now: NOW,
      staleBefore: new Date(NOW.getTime() - 1),
    });
    completeSetup(db, NOW);

    expect(reopenSetup(db, NOW)).toBe(false);
    expect(isSetupComplete(db)).toBe(true);
  });

  it("reports false on an installation that was never marked complete", () => {
    ensureInstance(db);
    expect(reopenSetup(db, NOW)).toBe(false);
  });
});

describe("resolveSetupProgress", () => {
  it("derives every step's state from rows rather than from a carried position", () => {
    const empty = resolveSetupProgress(db, { educatorSeeded: false });
    expect(empty).toMatchObject({
      educatorExists: false,
      aliasId: null,
      classroomId: null,
      studentCount: 0,
    });

    seedEducatorRow();
    const alias = seedAlias();
    const classroom = createClassroom(db, { name: "7.B" });
    createStudent(db, {
      classroomId: classroom.id,
      label: "kaek-graevling",
      credentialDigest: "digest",
      credentialHint: "ABCD",
    });

    expect(resolveSetupProgress(db, { educatorSeeded: false })).toMatchObject({
      educatorExists: true,
      aliasId: alias.id,
      classroomId: classroom.id,
      studentCount: 1,
    });
  });

  it("finishes only once an account, a model and a class all exist", () => {
    expect(canFinishSetup(resolveSetupProgress(db, { educatorSeeded: false }))).toBe(false);

    seedEducatorRow();
    seedAlias();
    expect(canFinishSetup(resolveSetupProgress(db, { educatorSeeded: false }))).toBe(false);

    createClassroom(db, { name: "7.B" });
    expect(canFinishSetup(resolveSetupProgress(db, { educatorSeeded: false }))).toBe(true);
  });
});

describe("resolveStep", () => {
  const progress = () => resolveSetupProgress(db, { educatorSeeded: false });

  it("starts at the account step on a cold installation", () => {
    expect(resolveStep(progress(), null)).toBe("educator");
  });

  it("refuses a step the persisted state does not justify", () => {
    // No account yet, so the model step would submit against nothing.
    expect(resolveStep(progress(), "alias")).toBe("educator");
    expect(resolveStep(progress(), "finish")).toBe("educator");
  });

  it("lets the gateway step be reached as soon as the model step can be", () => {
    seedEducatorRow();
    expect(resolveStep(progress(), null)).toBe("gateway");
    expect(resolveStep(progress(), "alias")).toBe("alias");
    expect(resolveStep(progress(), "classroom")).toBe("gateway");
  });

  it("allows going back, because every step is idempotent", () => {
    seedEducatorRow();
    seedAlias();
    createClassroom(db, { name: "7.B" });

    expect(resolveStep(progress(), "educator")).toBe("educator");
    expect(resolveStep(progress(), "alias")).toBe("alias");
  });

  it("lands on the finish step once pupils exist, and on the pupil step before that", () => {
    seedEducatorRow();
    seedAlias();
    const classroom = createClassroom(db, { name: "7.B" });
    expect(resolveStep(progress(), null)).toBe("students");

    createStudent(db, {
      classroomId: classroom.id,
      label: "kaek-graevling",
      credentialDigest: "digest",
      credentialHint: "ABCD",
    });
    expect(resolveStep(progress(), null)).toBe("finish");
  });

  it("ignores an unrecognised step rather than rendering nothing", () => {
    expect(resolveStep(progress(), "../../etc/passwd")).toBe("educator");
    expect(resolveStep(progress(), "")).toBe("educator");
  });

  it("hides and refuses the account step when it comes from deployment configuration", () => {
    seedEducatorRow();
    const seeded = resolveSetupProgress(db, { educatorSeeded: true });

    expect(visibleSteps(seeded)).not.toContain("educator");
    expect(resolveStep(seeded, "educator")).toBe("gateway");
  });
});
