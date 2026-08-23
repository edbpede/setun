import type { ClassroomStatus } from "$lib/server/classroom/status";

/**
 * The classroom state pushed to a tab (PRD §6, §8).
 *
 * "Connected tabs learn of the change over the classroom-state channel at once;
 * enforcement never depends on their having heard."
 *
 * So this is presentation only. The composer may linger on screen for a moment
 * after a lock lands, and the send will be refused by the server all the same
 * (§8, §21).
 *
 * Starts empty rather than seeded from the page load: the load's own status is
 * what the page renders until the channel has something to say, which keeps the
 * server-rendered first paint correct without this container reading page data.
 *
 * The type import is erased at compile time, so no server code enters the
 * bundle — the pattern the whole client/server boundary relies on.
 */
export class ClassroomState {
  status = $state<ClassroomStatus | null>(null);

  #source: EventSource | null = null;

  /**
   * Connect to the channel. Returns the teardown, so a caller in an `$effect`
   * can simply return it.
   *
   * `EventSource` rather than a `fetch` reader: this endpoint is a GET with no
   * body, and the browser's own reconnection is exactly the behaviour wanted on
   * a school network.
   */
  connect(url = "/api/classroom-state"): () => void {
    this.disconnect();

    const source = new EventSource(url);
    this.#source = source;

    source.addEventListener("status", (event) => {
      try {
        this.status = JSON.parse((event as MessageEvent<string>).data) as ClassroomStatus;
      } catch {
        // A truncated frame is not worth discarding a working connection over.
      }
    });

    return () => this.disconnect();
  }

  disconnect(): void {
    this.#source?.close();
    this.#source = null;
  }
}
