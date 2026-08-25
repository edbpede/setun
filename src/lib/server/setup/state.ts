import type { AppDatabase } from "../db/client";
import { listClassrooms } from "../db/queries/classrooms";
import { getFirstEducator } from "../db/queries/educators";
import { adoptSetup, ensureInstance, readInstance } from "../db/queries/instance";
import { listAliases } from "../db/queries/model-aliases";
import { listClassroomStudents } from "../db/queries/students";
import { log } from "../logging";

/**
 * Whether this installation still needs setting up, and how far it has got
 * (PRD §6.2, §7, §17).
 *
 * Two rules govern everything here.
 *
 * **The gate reads completion and nothing else.** Not "does an educator exist" —
 * the wizard creates one at its first step and still has three steps to go, so
 * collapsing the two conditions would open the gate mid-wizard onto a panel with
 * no model alias and no classroom. Educator existence is consulted in exactly two
 * places: the adoption rule below, and recovery's precondition.
 *
 * **Progress is derived from persisted state, never carried.** There is no
 * session variable and no hidden field saying which step is next; each step's
 * "already done?" is a row that either exists or does not. A crash between steps
 * therefore costs nothing, and a back-navigation cannot double-provision,
 * because the step's own action updates the row its predicate found.
 */

export const SETUP_PATH = "/setup";

/**
 * Paths the gate lets through while setup is incomplete.
 *
 * The wizard itself, the client bundle it needs to be more than a stack of plain
 * forms, and the two files a browser and a crawler fetch without being asked to.
 * Everything else redirects: a half-configured Setun has nothing else worth
 * showing, and a login form that cannot succeed is worse than a redirect.
 */
const EXEMPT_PATHS: ReadonlySet<string> = new Set([
  "/favicon.ico",
  "/robots.txt",
  "/setun-mark.svg",
]);

export function isSetupGateExempt(pathname: string): boolean {
  if (EXEMPT_PATHS.has(pathname)) return true;
  if (pathname === SETUP_PATH || pathname.startsWith(`${SETUP_PATH}/`)) return true;
  return pathname.startsWith("/_app/");
}

/**
 * The flag, read straight from the row.
 *
 * Not cached. A stale `true` would be harmless, but a stale `false` locks the
 * operator out of their own installation for as long as the process lives, and
 * the read is one primary-key lookup — there is nothing here worth the risk of
 * an invalidation that is forgotten.
 */
export function isSetupComplete(db: AppDatabase): boolean {
  return readInstance(db)?.setupCompletedAt != null;
}

/**
 * Adopt an installation that predates the wizard, at boot (PRD §6.2).
 *
 * Every Setun before this phase seeded its educator from deployment
 * configuration and had no notion of setup. Putting a gate in front of those
 * installations without this would lock every one of them out on upgrade, and
 * would hand a fresh claim window to whoever reached the port first.
 *
 * So: an installation whose wizard has never been claimed and that already has
 * an operator account — either a row in the table, or seed credentials in the
 * environment that boot is in the middle of applying — is a finished
 * installation, and is marked as one. Because the condition includes
 * `setupStartedAt IS NULL`, adoption is skipped forever once a browser has
 * claimed the wizard: a half-finished setup is never mistaken for a finished
 * install.
 */
export function adoptExistingInstall(
  db: AppDatabase,
  input: { educatorConfigured: boolean; now?: Date },
): boolean {
  const row = ensureInstance(db);
  if (row.setupCompletedAt !== null || row.setupStartedAt !== null) return false;

  // The environment half matters because seeding is asynchronous: on a cold
  // start with seed credentials set, the row does not exist yet at this instant,
  // and waiting for it would make the first request's answer depend on a race.
  if (!input.educatorConfigured && !getFirstEducator(db)) return false;

  const adopted = adoptSetup(db, input.now ?? new Date());
  if (adopted) {
    log.info(
      input.educatorConfigured
        ? "first-run setup skipped: the operator account comes from deployment configuration"
        : "existing installation adopted: first-run setup marked complete",
    );
  }
  return adopted;
}

/** The wizard's screens, in order. */
export const SETUP_STEPS = [
  "educator",
  "gateway",
  "alias",
  "classroom",
  "students",
  "finish",
] as const;

export type SetupStep = (typeof SETUP_STEPS)[number];

export interface SetupProgress {
  /** An operator account exists. Step 1's derivation. */
  readonly educatorExists: boolean;
  /** Seed credentials are configured, so step 1 is skipped entirely (§6.2, §7). */
  readonly educatorSeeded: boolean;
  /** The alias the wizard created, re-found rather than remembered. Step 3's derivation. */
  readonly aliasId: string | null;
  /** Step 4's derivation. */
  readonly classroomId: string | null;
  /** Step 5 is always skippable, so this only chooses where a reload lands. */
  readonly studentCount: number;
}

/**
 * Read the whole of setup's progress in one place.
 *
 * The alias and classroom are the *earliest created* rather than merely the
 * first row returned. During setup there is at most one of each, so the choice
 * only matters for determinism — but a step that edited a different row on a
 * reload than it created a minute earlier is exactly the double-provisioning
 * bug the derivation exists to prevent.
 */
export function resolveSetupProgress(
  db: AppDatabase,
  input: { educatorSeeded: boolean },
): SetupProgress {
  const byCreation = <T extends { createdAt: Date }>(rows: T[]): T | undefined =>
    [...rows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0];

  const alias = byCreation(listAliases(db));
  const classroom = byCreation(listClassrooms(db));

  return {
    educatorExists: getFirstEducator(db) !== undefined,
    educatorSeeded: input.educatorSeeded,
    aliasId: alias?.id ?? null,
    classroomId: classroom?.id ?? null,
    studentCount: classroom ? listClassroomStudents(db, classroom.id).length : 0,
  };
}

/** Whether the finish action's prerequisites hold: an account, a model, a room. */
export function canFinishSetup(progress: SetupProgress): boolean {
  return progress.educatorExists && progress.aliasId !== null && progress.classroomId !== null;
}

/** The steps this installation shows; the account step disappears when env-seeded. */
export function visibleSteps(progress: SetupProgress): SetupStep[] {
  return SETUP_STEPS.filter((step) => step !== "educator" || !progress.educatorSeeded);
}

/**
 * The furthest step the persisted state justifies showing.
 *
 * A prerequisite that has not been met is not merely hidden — it cannot be
 * navigated to, because the step after it would submit against a row that does
 * not exist. Going *back* is always allowed: every step is idempotent.
 */
function furthestStep(progress: SetupProgress): SetupStep {
  if (!progress.educatorExists) return "educator";
  // The gateway check sits between the account and the alias and persists
  // nothing, so it is reachable as soon as the alias step is.
  if (progress.aliasId === null) return "alias";
  if (progress.classroomId === null) return "classroom";
  return "finish";
}

/** Where a reload lands when the URL names no step. */
function defaultStep(progress: SetupProgress): SetupStep {
  if (!progress.educatorExists) return progress.educatorSeeded ? "gateway" : "educator";
  if (progress.aliasId === null) return "gateway";
  if (progress.classroomId === null) return "classroom";
  return progress.studentCount > 0 ? "finish" : "students";
}

/**
 * Resolve the step to render: the requested one when the state allows it, and
 * the derived position otherwise.
 */
export function resolveStep(progress: SetupProgress, requested: string | null): SetupStep {
  const fallback = defaultStep(progress);

  const wanted = SETUP_STEPS.find((step) => step === requested);
  if (!wanted) return fallback;
  if (wanted === "educator" && progress.educatorSeeded) return fallback;

  const limit = SETUP_STEPS.indexOf(furthestStep(progress));
  return SETUP_STEPS.indexOf(wanted) <= limit ? wanted : fallback;
}
