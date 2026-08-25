import { cp, mkdir, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { format, parseISO, subDays } from "date-fns";
import { formatInTimeZone } from "date-fns-tz";
import type { AppDatabase } from "../db/client";
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

/** `setun-2026-08-25.sqlite` — sortable, one per night, and obviously what it is. */
export function snapshotName(day: string): string {
  return `${SNAPSHOT_PREFIX}${day}${SNAPSHOT_SUFFIX}`;
}

export function storageSnapshotName(day: string): string {
  return `${STORAGE_PREFIX}${day}`;
}

/** The day a snapshot belongs to, or null for a name this job did not write. */
export function snapshotDay(name: string): string | null {
  const match = /^(?:setun-|storage-)(\d{4}-\d{2}-\d{2})(?:\.sqlite)?$/.exec(name);
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
  readonly created: boolean;
  readonly pruned: string[];
}

/**
 * Take tonight's snapshot if it is due and not already taken, then prune.
 *
 * Idempotent by construction: the day's file either exists or it does not, so
 * the job may run every hour and a restart never doubles a night.
 */
export async function runBackup(
  options: BackupOptions,
  now: Date = new Date(),
): Promise<BackupOutcome> {
  const { db, storagePath, backupPath, timezone } = options;
  const retainDays = options.retainDays ?? BACKUP_RETAINED_DAYS;

  await mkdir(backupPath, { recursive: true });

  const day = formatInTimeZone(now, timezone, "yyyy-MM-dd");
  const hour = Number(formatInTimeZone(now, timezone, "H"));

  const existing = await readdir(backupPath);
  const due = hour >= BACKUP_HOUR && !existing.includes(snapshotName(day));

  if (due) {
    const target = join(backupPath, snapshotName(day));
    // A leftover from a run that died mid-vacuum: SQLite refuses to write into
    // an existing file, and a half-written snapshot is worth less than none.
    await rm(target, { force: true });
    // Bound as a literal because SQLite does not accept a parameter here; the
    // path is deployment configuration, never request input.
    db.$client.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`);

    if (await exists(storagePath)) {
      const storageTarget = join(backupPath, storageSnapshotName(day));
      await rm(storageTarget, { recursive: true, force: true });
      await cp(storagePath, storageTarget, { recursive: true });
    }
  }

  return { day, created: due, pruned: await prune(backupPath, day, retainDays) };
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

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

export function backupJob(options: BackupOptions): ScheduledJob {
  return {
    name: "backup",
    intervalMs: BACKUP_INTERVAL_MS,
    runAtStart: true,
    async run(now) {
      const outcome = await runBackup(options, now);
      if (outcome.created) console.info(`backup snapshot ${snapshotName(outcome.day)} written`);
      if (outcome.pruned.length > 0) {
        console.info(`backup pruned ${outcome.pruned.length} expired snapshot(s)`);
      }
    },
  };
}
