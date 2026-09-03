import type { Attachment } from "svelte/attachments";

/**
 * Keeping the composer above the on-screen keyboard (PRD §20).
 *
 * "The on-screen keyboard in tablet mode is handled explicitly so the composer
 * and latest message stay visible." The target device is a convertible: folded
 * into tablet mode it raises a keyboard that covers the bottom of the layout
 * viewport, and `100svh` does not shrink for it — the page keeps its height and
 * the composer goes underneath.
 *
 * `visualViewport` reports the part actually on screen, so the chat column is
 * sized to that instead. Applied as an attachment rather than an action, and as
 * an inline height rather than a class, because the value is a number that
 * changes rather than a state that toggles.
 */
export const fitVisualViewport: Attachment<HTMLElement> = (node) => {
  const viewport = globalThis.visualViewport;
  if (!viewport) return;

  const apply = () => {
    // `offsetTop` is non-zero while the page is scrolled within a pinch-zoomed
    // viewport; subtracting it keeps the bottom edge where the keyboard is.
    node.style.height = `${viewport.height - viewport.offsetTop}px`;
  };

  apply();
  viewport.addEventListener("resize", apply);
  viewport.addEventListener("scroll", apply);

  return () => {
    viewport.removeEventListener("resize", apply);
    viewport.removeEventListener("scroll", apply);
    node.style.removeProperty("height");
  };
};

/** Where the conversation was, per conversation. */
function positionKey(conversationId: string): string {
  return `setun:transcript:${conversationId}`;
}

/**
 * Where the pupil was reading, and how much of the thread was under them.
 *
 * The offset alone is not the position: a transcript mounts its newest thirty
 * messages and widens only when the pupil asks for more, so an offset measured
 * against a widened column means somewhere else entirely in a fresh one.
 */
export interface TranscriptPosition {
  /** The scroller's `scrollTop`, in pixels. */
  readonly offset: number;
  /** How many messages were mounted, so "show earlier" survives the discard. */
  readonly window: number;
}

/**
 * Reading position across a tab discard (PRD §20).
 *
 * "Composer drafts and scroll position survive tab discard, and in-flight turns
 * resume from the server." A Chromebook with 4 GB discards background tabs
 * routinely, and returning to the top of a long lesson is the difference between
 * picking up where you were and starting again.
 *
 * `sessionStorage`, like the composer draft: the value belongs to this tab and
 * this conversation, and nothing about a scroll offset should outlive the
 * browsing session or reach another device.
 *
 * Null means "nothing stored", which a bare number could not say: a pupil who
 * had read back to the very top stored a zero, and a zero read back as no
 * position at all left them at the newest end instead.
 */
export function readTranscriptPosition(conversationId: string | null): TranscriptPosition | null {
  if (!conversationId || typeof sessionStorage === "undefined") return null;

  try {
    const stored = sessionStorage.getItem(positionKey(conversationId));
    if (stored === null) return null;

    const parsed: unknown = JSON.parse(stored);
    if (typeof parsed !== "object" || parsed === null) return null;

    const { offset, window } = parsed as Partial<TranscriptPosition>;
    if (!Number.isFinite(offset) || !Number.isFinite(window)) return null;

    return { offset: Number(offset), window: Number(window) };
  } catch {
    // A value written by an older shape, or storage blocked outright. Neither is
    // worth an exception on the way into a lesson.
    return null;
  }
}

export function writeTranscriptPosition(
  conversationId: string | null,
  position: TranscriptPosition,
): void {
  if (!conversationId || typeof sessionStorage === "undefined") return;

  try {
    sessionStorage.setItem(
      positionKey(conversationId),
      JSON.stringify({ offset: Math.round(position.offset), window: position.window }),
    );
  } catch {
    // Site data is blocked. The transcript still works; it just does not come
    // back to the same line after a discard.
  }
}
