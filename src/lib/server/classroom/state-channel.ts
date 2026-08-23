import type { AppDatabase } from "../db/client";
import type { Student } from "../db/schema";
import { type ClassroomStatus, resolveClassroomStatus, statusFingerprint } from "./status";

/**
 * The classroom-state push channel (PRD §6, §8).
 *
 * "Connected tabs learn of the change over the classroom-state channel at once;
 * enforcement never depends on their having heard."
 *
 * That second clause is the important one. Nothing here is a security boundary:
 * a tab that missed a lock, or never connected at all, is refused by
 * `enforcement.ts` on its next request exactly as an informed one would be. This
 * exists so a pupil sees the room close rather than discovering it by being
 * turned away (§8).
 *
 * Two sources of change, so two triggers:
 *
 * - An educator's Open now or Lock, which must land immediately — the registry
 *   below, notified by the form action.
 * - A scheduled window opening or closing, and a turn finishing and spending
 *   allowance, which no action announces — the poll interval.
 *
 * A fingerprint suppresses the ticks that changed nothing, so an idle classroom
 * costs one comparison per interval per tab and sends no bytes.
 *
 * On module-scope state in a server module: this is process infrastructure, the
 * same category as `liveTurns` — a listener set keyed by classroom, holding no
 * request or user state and outliving no request but its own subscribers.
 */

type Listener = () => void;

export class ClassroomStateChannel {
  readonly #listeners = new Map<string, Set<Listener>>();

  /** Wake every tab watching this classroom. Returns how many were notified. */
  publish(classroomId: string): number {
    const listeners = this.#listeners.get(classroomId);
    if (!listeners) return 0;

    for (const listener of listeners) listener();
    return listeners.size;
  }

  subscribe(classroomId: string, listener: Listener): () => void {
    const listeners = this.#listeners.get(classroomId) ?? new Set<Listener>();
    listeners.add(listener);
    this.#listeners.set(classroomId, listeners);

    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.#listeners.delete(classroomId);
    };
  }

  /** Tabs currently watching a classroom. Exists for the integration test. */
  watcherCount(classroomId: string): number {
    return this.#listeners.get(classroomId)?.size ?? 0;
  }
}

/** The process-wide channel. One process serves every connected tab. */
export const classroomStateChannel = new ClassroomStateChannel();

/**
 * How often a connection re-resolves without being told to.
 *
 * A lesson boundary is worth being a few seconds late for; a lock is not, and
 * that path does not wait for this.
 */
export const CLASSROOM_POLL_INTERVAL_MS = 15_000;

export interface WatchOptions {
  readonly signal?: AbortSignal;
  readonly intervalMs?: number;
  readonly channel?: ClassroomStateChannel;
  readonly now?: () => Date;
}

/**
 * Yield this student's classroom status: once immediately, then on every change.
 *
 * The first value is unconditional — a tab that has just connected knows
 * nothing, and waiting for a change would leave it blank until one happened.
 */
export async function* watchClassroomStatus(
  db: AppDatabase,
  student: Student,
  options: WatchOptions = {},
): AsyncGenerator<ClassroomStatus> {
  const channel = options.channel ?? classroomStateChannel;
  const interval = options.intervalMs ?? CLASSROOM_POLL_INTERVAL_MS;
  const now = options.now ?? (() => new Date());

  let current = resolveClassroomStatus(db, student, now());
  let fingerprint = statusFingerprint(current);
  yield current;

  let wake: (() => void) | null = null;
  const nudge = () => {
    wake?.();
  };
  const unsubscribe = channel.subscribe(student.classroomId, nudge);
  options.signal?.addEventListener("abort", nudge, { once: true });

  try {
    while (!options.signal?.aborted) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          wake = null;
          resolve();
        }, interval);

        wake = () => {
          clearTimeout(timer);
          wake = null;
          resolve();
        };
      });

      if (options.signal?.aborted) return;

      current = resolveClassroomStatus(db, student, now());
      const next = statusFingerprint(current);
      if (next === fingerprint) continue;

      fingerprint = next;
      yield current;
    }
  } finally {
    unsubscribe();
    options.signal?.removeEventListener("abort", nudge);
  }
}
