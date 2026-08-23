import type { GatewayEvent } from "$lib/server/gateway/events";

/**
 * The in-flight turn, client side (PRD §10).
 *
 * A container class rather than bare exported `let`s, so reactivity survives the
 * import boundary — and instantiated per session through context rather than as
 * a module singleton, because a module singleton is shared across every SSR
 * request on the server.
 *
 * `GatewayEvent` is imported as a type only. Types are erased at compile time,
 * so this does not pull a server module into the client bundle; it is the same
 * normalised contract on both sides of the wire (§10).
 */

/** Why the last turn ended, when it ended in a way worth telling the student. */
export type TurnNotice = "aborted" | "interrupted" | "error" | null;

export class StreamingTurn {
  /** Text accumulated so far. Rendered as plain preformatted text while streaming (§20). */
  text = $state("");
  turnId = $state<string | null>(null);
  /** Last sequence number applied — the cursor a resume continues from (§10). */
  lastSeq = $state(-1);
  notice = $state<TurnNotice>(null);
  #streaming = $state(false);

  get streaming(): boolean {
    return this.#streaming;
  }

  get isEmpty(): boolean {
    return this.text.length === 0;
  }

  begin(turnId: string): void {
    this.turnId = turnId;
    this.text = "";
    this.lastSeq = -1;
    this.notice = null;
    this.#streaming = true;
  }

  /** Resume an existing turn, keeping any text already rendered. */
  resume(turnId: string, afterSeq: number): void {
    this.turnId = turnId;
    this.lastSeq = afterSeq;
    this.notice = null;
    this.#streaming = true;
  }

  /**
   * Apply one normalised event.
   *
   * Events at or below the cursor are ignored, so a resume that overlaps what
   * the tab already rendered cannot duplicate text (§10).
   */
  apply(event: GatewayEvent, seq: number): void {
    if (seq <= this.lastSeq) return;
    this.lastSeq = seq;

    switch (event.type) {
      case "text-delta":
        this.text += event.text;
        break;
      case "error":
        this.notice = "error";
        break;
      case "done":
        this.#streaming = false;
        if (event.reason === "aborted") this.notice = "aborted";
        else if (event.reason === "interrupted") this.notice = "interrupted";
        else if (event.reason === "error") this.notice = "error";
        break;
      default:
        // Tool and permission events arrive in Phase 3; ignored until then.
        break;
    }
  }

  /** Give up on the stream without claiming the turn ended. */
  detach(): void {
    this.#streaming = false;
  }

  clear(): void {
    this.text = "";
    this.turnId = null;
    this.lastSeq = -1;
    this.notice = null;
    this.#streaming = false;
  }
}
