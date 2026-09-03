import { createRawSnippet } from "svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-svelte";
import * as m from "$lib/paraglide/messages";
import { type ChatMessage, ConversationState } from "$lib/state/conversation.svelte";
import Transcript from "./Transcript.svelte";

/**
 * The reading surface (PRD §10, §20, §22).
 *
 * The behaviour under test is what happens to the scroll: a pupil reading back
 * through a lesson must not be dragged forward by an answer still arriving, and
 * must have one way to return to it.
 */

function message(id: string, role: "user" | "assistant", text: string): ChatMessage {
  return { id, role, parts: [{ type: "text", text }] };
}

/** Enough messages to make the scroller scroll at any sane viewport. */
function longThread(count: number): ChatMessage[] {
  return Array.from({ length: count }, (_, at) =>
    message(`m${at}`, at % 2 === 0 ? "user" : "assistant", `Besked nummer ${at}. `.repeat(20)),
  );
}

/**
 * The scroller, given a height to scroll inside.
 *
 * On the route the transcript is a flex child of a viewport-height column; a
 * component test mounts it into an unconstrained body, where nothing overflows
 * and every scroll assertion would pass vacuously.
 */
function scroller(): HTMLElement {
  const root = document.querySelector<HTMLElement>("[data-transcript]");
  if (!root) throw new Error("the transcript did not mount");
  root.style.height = "320px";

  const element = root.querySelector<HTMLElement>(".overflow-y-auto");
  if (!element) throw new Error("the transcript has no scroller");
  return element;
}

const empty = createRawSnippet(() => ({
  render: () => `<div data-testid="starters">Stil dit første spørgsmål</div>`,
}));

describe("Transcript", () => {
  // The reading position is real per-tab state now that a stored zero is told
  // apart from no stored value at all, so one case's scroll must not become the
  // next one's restore.
  beforeEach(() => sessionStorage.clear());

  it("shows the opening surface only while the thread is empty", async () => {
    const conversation = new ConversationState();
    render(Transcript, { conversation, conversationId: null, empty });

    await expect.element(page.getByTestId("starters")).toBeVisible();

    conversation.replaceMessages([message("m1", "user", "hej")]);

    await expect.element(page.getByTestId("starters")).not.toBeInTheDocument();
  });

  it("windows a long thread and widens it on request (§20)", async () => {
    const conversation = new ConversationState();
    conversation.replaceMessages(longThread(45));

    render(Transcript, { conversation, conversationId: "c1" });

    // A lesson-long thread is hundreds of messages, each with its own markdown
    // render; laying all of them out to show the last five is what the window
    // exists to avoid.
    const earlier = page.getByRole("button", { name: m.chat_show_earlier({ count: 15 }) });
    await expect.element(earlier).toBeVisible();

    await earlier.click();
    await expect.element(earlier).not.toBeInTheDocument();
  });

  it("stays where a pupil scrolled back to, and offers one way forward", async () => {
    const conversation = new ConversationState();
    conversation.replaceMessages(longThread(20));

    render(Transcript, { conversation, conversationId: "c1" });

    const element = scroller();
    await vi.waitFor(() => expect(element.scrollHeight).toBeGreaterThan(element.clientHeight));

    element.scrollTo({ top: 0 });
    element.dispatchEvent(new Event("scroll"));

    const jump = page.getByRole("button", { name: m.chat_jump_to_latest() });
    await expect.element(jump).toBeVisible();

    // An answer arriving must not drag the pupil forward a line at a time.
    conversation.turn.begin("turn-1");
    conversation.turn.apply({ type: "text-delta", text: "Et loop gentager…" }, 0);
    await vi.waitFor(() => expect(element.scrollTop).toBe(0));

    await jump.click();
    await vi.waitFor(() =>
      expect(element.scrollHeight - element.scrollTop - element.clientHeight).toBeLessThan(2),
    );
    await expect.element(jump).not.toBeInTheDocument();
  });

  it("does not slide the mounted window under a pupil reading back (§20)", async () => {
    const conversation = new ConversationState();
    const thread = longThread(45);
    conversation.replaceMessages(thread);

    render(Transcript, { conversation, conversationId: "c1" });

    const element = scroller();
    await vi.waitFor(() => expect(element.scrollHeight).toBeGreaterThan(element.clientHeight));

    // Reading back: the window holds the newest thirty, so fifteen are behind
    // "show earlier" and `m15` is the oldest thing mounted.
    element.scrollTo({ top: 0 });
    element.dispatchEvent(new Event("scroll"));
    await expect
      .element(page.getByRole("button", { name: m.chat_show_earlier({ count: 15 }) }))
      .toBeVisible();

    conversation.replaceMessages([...thread, message("m45", "assistant", "Et loop gentager…")]);

    // The tail slice would have dropped `m15` to make room, and content leaving
    // above the viewport pulls everything the pupil is reading up with it.
    await expect
      .element(page.getByRole("button", { name: m.chat_show_earlier({ count: 15 }) }))
      .toBeVisible();
  });

  it("follows the stream for a pupil already at the newest end", async () => {
    const conversation = new ConversationState();
    conversation.replaceMessages(longThread(20));

    render(Transcript, { conversation, conversationId: "c1" });

    const element = scroller();

    conversation.turn.begin("turn-1");
    conversation.turn.apply(
      { type: "text-delta", text: "Et loop gentager sig selv. ".repeat(40) },
      0,
    );

    // Nobody has scrolled away, so the newest text pulls the view with it.
    await vi.waitFor(() =>
      expect(element.scrollHeight - element.scrollTop - element.clientHeight).toBeLessThan(2),
    );
  });
});
