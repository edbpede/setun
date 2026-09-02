import { describe, expect, it } from "bun:test";
import {
  ARTIFACT_CHANNEL,
  asHostMessage,
  asSandboxMessage,
  asStageMessage,
  CONSOLE_MAX_LINES,
  CONSOLE_MAX_TEXT,
  STORAGE_MAX_KEYS,
} from "./protocol";

/**
 * The vocabulary both ends validate against (PRD §14).
 *
 * Every message here crosses an origin boundary in one direction or the other,
 * and the party on each side treats the other as untrusted — the sandbox because
 * the application is not its origin, the application because the sandbox runs
 * generated code. So these assertions are mostly about what is *refused*.
 */

const envelope = { channel: ARTIFACT_CHANNEL };

describe("asHostMessage", () => {
  it("reads a render with its artifact", () => {
    expect(
      asHostMessage({
        ...envelope,
        type: "render",
        runId: "r1",
        artifactId: "a1",
        language: "html",
        source: "<p>hi</p>",
      }),
    ).toEqual({
      channel: ARTIFACT_CHANNEL,
      type: "render",
      runId: "r1",
      artifactId: "a1",
      language: "html",
      source: "<p>hi</p>",
    });
  });

  it("refuses a render without an artifact to group its storage under", () => {
    expect(
      asHostMessage({ ...envelope, type: "render", runId: "r1", language: "html", source: "x" }),
    ).toBeNull();
  });

  it("reads clear and focus", () => {
    expect(asHostMessage({ ...envelope, type: "clear" })?.type).toBe("clear");
    expect(asHostMessage({ ...envelope, type: "focus" })?.type).toBe("focus");
  });

  it("refuses anything off the channel", () => {
    expect(asHostMessage({ channel: "other", type: "focus" })).toBeNull();
    expect(asHostMessage(null)).toBeNull();
  });
});

describe("asSandboxMessage", () => {
  it("reads a console batch", () => {
    const message = asSandboxMessage({
      ...envelope,
      type: "console",
      runId: "r1",
      lines: [{ level: "warn", text: "pas på" }],
    });

    expect(message).toEqual({
      channel: ARTIFACT_CHANNEL,
      type: "console",
      runId: "r1",
      lines: [{ level: "warn", text: "pas på" }],
    });
  });

  it("caps a console batch at both ends", () => {
    const message = asSandboxMessage({
      ...envelope,
      type: "console",
      runId: "r1",
      lines: Array.from({ length: 400 }, () => ({ level: "log", text: "x".repeat(4_000) })),
    });

    expect(message?.type === "console" && message.lines).toHaveLength(CONSOLE_MAX_LINES);
    expect(message?.type === "console" && message.lines[0].text).toHaveLength(CONSOLE_MAX_TEXT);
  });

  it("drops a malformed line rather than the batch, and unknown levels become log", () => {
    const message = asSandboxMessage({
      ...envelope,
      type: "console",
      runId: "r1",
      lines: [{ level: "log", text: 7 }, "nope", { level: "table", text: "ok" }],
    });

    expect(message?.type === "console" && message.lines).toEqual([{ level: "log", text: "ok" }]);
  });

  it("refuses a console batch with no run", () => {
    expect(asSandboxMessage({ ...envelope, type: "console", lines: [] })).toBeNull();
  });
});

describe("asStageMessage", () => {
  it("reads a storage snapshot", () => {
    expect(
      asStageMessage({
        ...envelope,
        type: "storage",
        runId: "r1",
        area: "local",
        entries: { score: "12" },
      }),
    ).toEqual({
      channel: ARTIFACT_CHANNEL,
      type: "storage",
      runId: "r1",
      area: "local",
      entries: { score: "12" },
    });
  });

  it("refuses an unknown area", () => {
    expect(
      asStageMessage({ ...envelope, type: "storage", runId: "r1", area: "disk", entries: {} }),
    ).toBeNull();
  });

  it("drops non-string values and bounds the key count", () => {
    const entries: Record<string, unknown> = { a: 1, b: "ok" };
    for (let index = 0; index < 400; index++) entries[`k${index}`] = "v";

    const message = asStageMessage({
      ...envelope,
      type: "storage",
      runId: "r1",
      area: "session",
      entries,
    });

    expect(message?.type === "storage" && message.entries.a).toBeUndefined();
    expect(message?.type === "storage" && Object.keys(message.entries).length).toBeLessThanOrEqual(
      STORAGE_MAX_KEYS,
    );
  });

  it("bounds a snapshot by bytes as well as by count", () => {
    const message = asStageMessage({
      ...envelope,
      type: "storage",
      runId: "r1",
      area: "local",
      entries: { a: "x".repeat(70_000), b: "small" },
    });

    expect(message?.type === "storage" && Object.keys(message.entries)).toEqual([]);
  });

  it("still reads mounted and runtime-error", () => {
    expect(asStageMessage({ ...envelope, type: "mounted", runId: "r1" })?.type).toBe("mounted");
    expect(
      asStageMessage({ ...envelope, type: "runtime-error", runId: "r1", message: "boom" }),
    ).toEqual({
      channel: ARTIFACT_CHANNEL,
      type: "runtime-error",
      runId: "r1",
      message: "boom",
    });
  });
});
