import { beforeEach, describe, expect, it } from "bun:test";
import type { AppDatabase } from "../db/client";
import { allowAlias } from "../db/queries/classroom-aliases";
import { setClassroomState } from "../db/queries/classrooms";
import type { Classroom, ModelAlias, Student } from "../db/schema";
import { createTestDatabase, seedTestFixtures } from "../db/testing";
import { checkModelAccess } from "./enforcement";
import { ClassroomStateChannel, watchClassroomStatus } from "./state-channel";

/**
 * The classroom-state channel (plan 2.5, PRD §6, §8).
 *
 * Two things have to hold, and the second is the one that matters:
 *
 *  1. A state change reaches a connected client.
 *  2. Enforcement holds when the channel is severed — a tab that heard nothing
 *     is refused exactly like one that heard everything (§8, §21).
 */

let db: AppDatabase;
let classroom: Classroom;
let student: Student;
let alias: ModelAlias;

beforeEach(() => {
  db = createTestDatabase();
  const fixtures = seedTestFixtures(db);
  classroom = fixtures.classroom;
  student = fixtures.student;
  alias = fixtures.alias;

  allowAlias(db, { classroomId: classroom.id, modelAliasId: alias.id });
  setClassroomState(db, { classroomId: classroom.id, state: "open" });
});

describe("ClassroomStateChannel", () => {
  it("wakes every tab watching a classroom", () => {
    const channel = new ClassroomStateChannel();
    let woken = 0;

    channel.subscribe(classroom.id, () => woken++);
    channel.subscribe(classroom.id, () => woken++);

    expect(channel.publish(classroom.id)).toBe(2);
    expect(woken).toBe(2);
  });

  it("does not wake tabs watching a different classroom", () => {
    const channel = new ClassroomStateChannel();
    let woken = 0;

    channel.subscribe(classroom.id, () => woken++);

    expect(channel.publish("another-classroom")).toBe(0);
    expect(woken).toBe(0);
  });

  it("stops delivering once a tab unsubscribes", () => {
    const channel = new ClassroomStateChannel();
    let woken = 0;

    const unsubscribe = channel.subscribe(classroom.id, () => woken++);
    unsubscribe();

    channel.publish(classroom.id);

    expect(woken).toBe(0);
    expect(channel.watcherCount(classroom.id)).toBe(0);
  });
});

describe("watchClassroomStatus", () => {
  it("yields the current status immediately, before anything changes", async () => {
    const abort = new AbortController();
    const watch = watchClassroomStatus(db, student, {
      signal: abort.signal,
      channel: new ClassroomStateChannel(),
    });

    const first = await watch.next();
    abort.abort();
    await watch.return(undefined);

    expect(first.value?.open).toBe(true);
    expect(first.value?.allowance.limitTokens).toBe(classroom.perStudentDailyTokens);
  });

  it("delivers a lock to a connected client", async () => {
    const channel = new ClassroomStateChannel();
    const abort = new AbortController();
    const watch = watchClassroomStatus(db, student, {
      signal: abort.signal,
      channel,
      intervalMs: 60_000,
    });

    const first = await watch.next();
    expect(first.value?.open).toBe(true);

    // The educator's Lock, exactly as the form action performs it.
    const pending = watch.next();
    // The subscription is registered as the generator suspends on its first
    // `next`; publishing before that would be a race the real endpoint cannot
    // have, because the educator's write happens on a later request.
    await Promise.resolve();
    setClassroomState(db, { classroomId: classroom.id, state: "locked" });
    channel.publish(classroom.id);

    const second = await pending;
    abort.abort();
    await watch.return(undefined);

    expect(second.value?.open).toBe(false);
    expect(second.value?.reason).toBe("explicit-lock");
  });

  it("does not re-send an unchanged status when woken", async () => {
    const channel = new ClassroomStateChannel();
    const abort = new AbortController();
    const watch = watchClassroomStatus(db, student, {
      signal: abort.signal,
      channel,
      intervalMs: 5,
    });

    await watch.next();

    // Nothing changed, so the only thing that ends this wait is the abort.
    const pending = watch.next();
    await Promise.resolve();
    channel.publish(classroom.id);
    channel.publish(classroom.id);

    abort.abort();
    const next = await pending;

    expect(next.done).toBe(true);
  });
});

describe("enforcement does not depend on the channel (§8, §21)", () => {
  it("refuses a locked classroom even when no tab is subscribed", () => {
    const channel = new ClassroomStateChannel();
    expect(channel.watcherCount(classroom.id)).toBe(0);

    setClassroomState(db, { classroomId: classroom.id, state: "locked" });

    const result = checkModelAccess({ db, student, modelAliasId: alias.id });

    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toBe("classroom-locked");
  });

  it("refuses a locked classroom even when the publish reached nobody", () => {
    setClassroomState(db, { classroomId: classroom.id, state: "locked" });
    // The severed channel: the educator's publish had no listeners at all.
    expect(new ClassroomStateChannel().publish(classroom.id)).toBe(0);

    expect(checkModelAccess({ db, student, modelAliasId: alias.id }).allowed).toBe(false);
  });
});
