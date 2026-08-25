import { cp, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { format, parseISO, subDays } from "date-fns";
import { formatInTimeZone } from "date-fns-tz";
import type { AppDatabase } from "../db/client";
import { log } from "../logging";
import type { ScheduledJob } from "./scheduler";

/**
 * Nightly backups (PRD §21, Appendix A).
 *
 * "Backups — a nightly snapshot job: SQLite online backup via `VACUUM INTO` plus
 * the images and skills directories, last 14 days retained on the volume — have
 * been restored successfully at least once."
 *
 * `VACUUM INTO` is SQLite's online backup: it reads through the same connection
 * the application is using, so the snapshot is consistent without stopping
 * writes and without a second process reading a file mid-checkpoint. WAL mode
 * makes a plain file copy of the database unsafe; this is the supported way.
 *
 * The second half of the sentence is the storage directory. Skill bodies and
 * their bundled resources are database columns in this implementation (§19), so
 * the snapshot already carries them; what lives outside the database is
 * attachments and generated images, and that whole tree is copied.
 *
 * Restore is a file copy in the other direction and is documented for the
 * operator in `docs/setun-operations.md` — the rehearsal §21 requires.
 */

/** Appendix A. */
export const BACKUP_RETAINED_DAYS = 14;

/** The hour, in the backup timezone, after which a night's snapshot is due. */
export const BACKUP_HOUR = 3;

/**
 * Hourly ticks, one snapshot a night.
 *
 * The job decides from the clock and from what is already on the volume rather
 * than from the tick, so a restart at 03:30 still produces that night's snapshot
 * and a machine that was asleep at 03:00 catches up at 04:00.
 */
export const BACKUP_INTERVAL_MS = 60 * 60 * 1000;

const SNAPSHOT_PREFIX = "setun-";
const SNAPSHOT_SUFFIX = ".sqlite";
const STORAGE_PREFIX = "storage-";

/**
 * The suffix a half-written snapshot wears until it is whole.
 *
 * Both halves are written under this name and renamed into place, so the final
 * name means "complete" rather than "started". Without that, a run killed
 * mid-`VACUUM INTO` or mid-copy leaves a truncated file whose mere presence
 * tells the next tick the night is done.
 */
const PENDING_SUFFIX = ".partial";

/** `setun-2026-08-25.sqlite` — sortable, one per night, and obviously what it is. */
export function snapshotName(day: string): string {
  return `${SNAPSHOT_PREFIX}${day}${SNAPSHOT_SUFFIX}`;
}

export function storageSnapshotName(day: string): string {
  return `${STORAGE_PREFIX}${day}`;
}

/**
 * The day a snapshot belongs to, or null for a name this job did not write.
 *
 * A pending name reads as its day too, so an abandoned half-written snapshot
 * ages out through the same prune rather than sitting on the volume forever.
 */
export function snapshotDay(name: string): string | null {
  const match = /^(?:setun-|storage-)(\d{4}-\d{2}-\d{2})(?:\.sqlite)?(?:\.partial)?$/.exec(name);
  return match ? match[1] : null;
}

export interface BackupOptions {
  readonly db: AppDatabase;
  readonly storagePath: string;
  readonly backupPath: string;
  /**
   * The zone the backup day is reckoned in — the classroom timezone by default.
   *
   * A snapshot is "nightly" in somebody's night, and a server in UTC would roll
   * the day mid-evening in Denmark. All timezone arithmetic goes through
   * `date-fns-tz` (§5).
   */
  readonly timezone: string;
  readonly retainDays?: number;
}

export interface BackupOutcome {
  readonly day: string;
  /** True when this run completed tonight's snapshot — either half of it. */
  readonly created: boolean;
  readonly pruned: string[];
}

/**
 * Take tonight's snapshot if it is due and not already taken, then prune.
 *
 * Idempotent by construction: the day's snapshots either exist or they do not,
 * so the job may run every hour and a restart never doubles a night. "Exist"
 * means both halves, and means them complete — an hourly retry is only worth
 * having if a night half-written is a night still due.
 */
export async function runBackup(
  options: BackupOptions,
  now: Date = new Date(),
): Promise<BackupOutcome> {
  const { db, storagePath, backupPath, timezone } = options;
  const retainDays = options.retainDays ?? BACKUP_RETAINED_DAYS;

  assertDisjoint(storagePath, backupPath);

  await mkdir(backupPath, { recursive: true });

  const day = formatInTimeZone(now, timezone, "yyyy-MM-dd");
  const hour = Number(formatInTimeZone(now, timezone, "H"));

  const existing = await readdir(backupPath);
  const hasDatabase = existing.includes(snapshotName(day));
  // Nothing outside the database on a fresh volume, and then nothing to copy.
  const wantsStorage = await exists(storagePath);
  const hasStorage = !wantsStorage || existing.includes(storageSnapshotName(day));

  // A night is due until *both* halves are on the volume. Reading the database
  // file alone would let a run that died after `VACUUM INTO` mark the night
  // complete, and the storage half the restore procedure copies back
  // (`docs/setun-operations.md` §6) would never arrive.
  const due = hour >= BACKUP_HOUR && !(hasDatabase && hasStorage);

  if (due) {
    if (!hasDatabase) {
      const target = join(backupPath, snapshotName(day));
      const pending = `${target}${PENDING_SUFFIX}`;
      // A leftover from a run that died mid-vacuum: SQLite refuses to write into
      // an existing file, and a half-written snapshot is worth less than none.
      await rm(pending, { force: true });
      // Bound as a literal because SQLite does not accept a parameter here; the
      // path is deployment configuration, never request input.
      db.$client.exec(`VACUUM INTO '${pending.replaceAll("'", "''")}'`);
      // The rename is what publishes it: until now the file could still be a
      // torn one, and after it the name is a promise the next tick can trust.
      await rename(pending, target);
    }

    if (wantsStorage) {
      const storageTarget = join(backupPath, storageSnapshotName(day));
      const pending = `${storageTarget}${PENDING_SUFFIX}`;
      await rm(pending, { recursive: true, force: true });
      await cp(storagePath, pending, { recursive: true });
      await rm(storageTarget, { recursive: true, force: true });
      await rename(pending, storageTarget);
    }
  }

  return { day, created: due, pruned: await prune(backupPath, day, retainDays) };
}

/**
 * Refuse a configuration where one tree contains the other.
 *
 * `cp` already declines to copy a directory into itself, so the misconfiguration
 * cannot run away — but it fails every night, from inside the copy, with an
 * `EINVAL` naming two paths, and only after the database snapshot has been
 * written. An operator reads this instead, before anything is copied.
 */
function assertDisjoint(storagePath: string, backupPath: string): void {
  const storage = resolve(storagePath);
  const backup = resolve(backupPath);

  if (storage === backup || contains(storage, backup) || contains(backup, storage)) {
    throw new Error(
      "backup misconfigured: the storage path and the backup path must be separate trees",
    );
  }
}

function contains(parent: string, child: string): boolean {
  const step = relative(parent, child);
  return step !== "" && !step.startsWith("..") && !isAbsolute(step);
}

/**
 * Keep the last `retainDays` days and remove the rest.
 *
 * Pruning is by the day in the name rather than by file mtime: a restored volume
 * or a copied directory carries whatever mtimes the copy gave it, and the name
 * is what the operator reads anyway.
 */
async function prune(backupPath: string, today: string, retainDays: number): Promise<string[]> {
  // Plain calendar arithmetic on a day string that is already local: the zone
  // was applied when the day was named, and applying it twice would move it.
  const cutoff = format(subDays(parseISO(today), retainDays - 1), "yyyy-MM-dd");

  const pruned: string[] = [];
  for (const name of await readdir(backupPath)) {
    const day = snapshotDay(name);
    // Anything this job did not write is left alone: the volume is the
    // operator's, and a sweep that removed unfamiliar files would be a trap.
    if (!day || day >= cutoff) continue;

    await rm(join(backupPath, name), { recursive: true, force: true });
    pruned.push(name);
  }

  return pruned.sort();
}

/**
 * Whether the storage tree is there — and never "no" because we could not tell.
 *
 * Absent is an answer: a deployment that has taken no uploads has no tree to
 * copy, and its nights are complete with the database half alone. Any other
 * `stat` failure is not an answer, and swallowing it would publish exactly the
 * half-night this job now retries — so it is raised, the scheduler logs it, and
 * the next tick tries again.
 */
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (cause) {
    if ((cause as { code?: string } | null)?.code === "ENOENT") return false;
    throw cause;
  }
}

export function backupJob(options: BackupOptions): ScheduledJob {
  return {
    name: "backup",
    intervalMs: BACKUP_INTERVAL_MS,
    runAtStart: true,
    async run(now) {
      const outcome = await runBackup(options, now);
      if (outcome.created) log.info(`backup snapshot ${snapshotName(outcome.day)} written`);
      if (outcome.pruned.length > 0) {
        log.info(`backup pruned ${outcome.pruned.length} expired snapshot(s)`);
      }
    },
  };
}
