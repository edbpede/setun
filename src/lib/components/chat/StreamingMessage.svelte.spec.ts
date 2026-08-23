import { describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-svelte";
import * as m from "$lib/paraglide/messages";
import { StreamingTurn } from "$lib/state/streaming-turn.svelte";
import StreamingMessage from "./StreamingMessage.svelte";

/**
 * The streaming message (plan 1.8, PRD §10, §20, §22).
 */

describe("StreamingMessage", () => {
  it("renders nothing before a turn starts", async () => {
    const turn = new StreamingTurn();
    render(StreamingMessage, { turn });

    await expect.element(page.getByRole("article")).not.toBeInTheDocument();
  });

  it("shows a thinking placeholder until the first delta lands", async () => {
    const turn = new StreamingTurn();
    turn.begin("turn-1");
    render(StreamingMessage, { turn });

    await expect.element(page.getByText(m.chat_thinking())).toBeVisible();
  });

  it("accumulates deltas into the streamed text", async () => {
    const turn = new StreamingTurn();
    turn.begin("turn-1");
    render(StreamingMessage, { turn });

    turn.apply({ type: "text-delta", text: "Et " }, 0);
    turn.apply({ type: "text-delta", text: "loop" }, 1);

    await expect.element(page.getByText("Et loop")).toBeVisible();
    await expect.element(page.getByText(m.chat_thinking())).not.toBeInTheDocument();
  });

  it("renders streamed markdown as plain text, not as HTML", async () => {
    const turn = new StreamingTurn();
    turn.begin("turn-1");
    render(StreamingMessage, { turn });

    // While streaming, text stays preformatted — no markdown parsing per delta (§20).
    turn.apply({ type: "text-delta", text: "**fed** tekst" }, 0);

    await expect.element(page.getByText("**fed** tekst")).toBeVisible();
    expect(document.querySelector("strong")).toBeNull();
  });

  it("never renders model output as live HTML", async () => {
    const turn = new StreamingTurn();
    turn.begin("turn-1");
    render(StreamingMessage, { turn });

    turn.apply({ type: "text-delta", text: "<img src=x onerror=alert(1)>" }, 0);

    // Model output is untrusted source; the streaming view escapes it (§5, §21).
    expect(document.querySelector("img")).toBeNull();
    await expect.element(page.getByText("<img src=x onerror=alert(1)>")).toBeVisible();
  });

  it("tells the student when they stopped the answer", async () => {
    const turn = new StreamingTurn();
    turn.begin("turn-1");
    render(StreamingMessage, { turn });

    turn.apply({ type: "text-delta", text: "halvvejs" }, 0);
    turn.apply({ type: "done", reason: "aborted" }, 1);

    await expect.element(page.getByText(m.chat_notice_aborted())).toBeVisible();
    // Partial content is preserved, not discarded (§10).
    await expect.element(page.getByText("halvvejs")).toBeVisible();
  });

  it("tells the student when a restart cut the answer short", async () => {
    const turn = new StreamingTurn();
    turn.resume("turn-1", -1);
    render(StreamingMessage, { turn });

    turn.apply({ type: "done", reason: "interrupted" }, 0);

    await expect.element(page.getByText(m.chat_notice_interrupted())).toBeVisible();
  });

  it("shows a friendly notice on gateway failure, never a raw error", async () => {
    const turn = new StreamingTurn();
    turn.begin("turn-1");
    render(StreamingMessage, { turn });

    turn.apply({ type: "error", message: "gateway-detail-that-must-not-render" }, 0);
    turn.apply({ type: "done", reason: "error" }, 1);

    await expect.element(page.getByText(m.chat_notice_error())).toBeVisible();
    // The event's own message never surfaces: the student sees the localised
    // notice, and the internal detail stays server-side (§9, §21).
    expect(document.body.textContent).not.toContain("gateway-detail-that-must-not-render");
  });
});
