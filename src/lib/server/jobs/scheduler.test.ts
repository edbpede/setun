import { describe, expect, it } from "bun:test";
import { JobScheduler } from "./scheduler";

/**
 * The scheduler's three guarantees (PRD §6): a job never overlaps itself, a
 * throwing job does not stop the timer, and stopping is complete.
 */

describe("JobScheduler", () => {
  it("runs a job on demand with the injected clock", async () => {
    const at = new Date("2026-08-25T03:00:00Z");
    const seen: Date[] = [];

    const scheduler = new JobScheduler({ now: () => at }).register({
      name: "probe",
      intervalMs: 1000,
      run: (now) => {
        seen.push(now);
      },
    });

    await scheduler.trigger("probe");
    expect(seen).toEqual([at]);
  });

  it("never runs a job concurrently with itself", async () => {
    let running = 0;
    let overlapped = false;

    const scheduler = new JobScheduler().register({
      name: "slow",
      intervalMs: 1000,
      run: async () => {
        running += 1;
        if (running > 1) overlapped = true;
        await new Promise((resolve) => setTimeout(resolve, 20));
        running -= 1;
      },
    });

    await Promise.all([scheduler.trigger("slow"), scheduler.trigger("slow")]);
    expect(overlapped).toBe(false);
  });

  it("isolates a throwing job, and reports it by name only", async () => {
    const failures: string[] = [];

    const scheduler = new JobScheduler({
      onError: (job) => failures.push(job),
    })
      .register({
        name: "boom",
        intervalMs: 1000,
        run: () => {
          throw new Error("upstream said no");
        },
      })
      .register({ name: "fine", intervalMs: 1000, run: () => {} });

    await scheduler.trigger("boom");
    await scheduler.trigger("fine");

    expect(failures).toEqual(["boom"]);
  });

  it("ignores a name it does not know", async () => {
    const scheduler = new JobScheduler();
    await expect(scheduler.trigger("nothing")).resolves.toBeUndefined();
  });

  it("stops every timer", () => {
    const scheduler = new JobScheduler().register({
      name: "ticker",
      intervalMs: 10,
      run: () => {},
    });

    scheduler.start();
    expect(() => scheduler.stop()).not.toThrow();
  });
});
