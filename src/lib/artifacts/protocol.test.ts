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

/** A render as the application sends one: a whole project and the file that runs. */
function render(overrides: Record<string, unknown> = {}) {
  return {
    ...envelope,
    type: "render",
    runId: "r1",
    artifactId: "a1",
    language: "tsx",
    entry: "src/App.tsx",
    files: { "src/App.tsx": "app", "src/styles.css": "css" },
    ...overrides,
  };
}

describe("asHostMessage", () => {
  it("reads a render with its artifact and its whole project", () => {
    expect(asHostMessage(render())).toEqual({
      channel: ARTIFACT_CHANNEL,
      type: "render",
      runId: "r1",
      artifactId: "a1",
      language: "tsx",
      entry: "src/App.tsx",
      files: { "src/App.tsx": "app", "src/styles.css": "css" },
    });
  });

  it("refuses a render without an artifact to group its storage under", () => {
    expect(asHostMessage(render({ artifactId: undefined }))).toBeNull();
  });

  /**
   * The gate a project crosses on its way into the sandbox origin (§21). A path
   * that would leave the project must not reach the bundler.
   */
  it("refuses a path that escapes the project", () => {
    expect(
      asHostMessage(render({ files: { "../secrets.ts": "x" }, entry: "../secrets.ts" })),
    ).toBeNull();
  });

  it("refuses a project over the caps", () => {
    const many = Object.fromEntries(Array.from({ length: 65 }, (_, at) => [`f${at}.ts`, "x"]));

    expect(asHostMessage(render({ files: { ...many, "src/App.tsx": "app" } }))).toBeNull();
  });

  it("refuses an entry the project does not hold", () => {
    expect(asHostMessage(render({ entry: "src/Missing.tsx" }))).toBeNull();
  });

  /** A `.css` entry declared `tsx` would be handed to the compiler as a component. */
  it("refuses an entry whose extension is not the language claimed", () => {
    expect(asHostMessage(render({ entry: "src/styles.css" }))).toBeNull();
  });

  it("refuses the single-source shape the protocol used to take", () => {
    expect(
      asHostMessage({
        ...envelope,
        type: "render",
        runId: "r1",
        artifactId: "a1",
        language: "html",
        source: "<p>hi</p>",
      }),
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
  it("reads a run that mounted and then threw, apart from one that failed", () => {
    expect(asSandboxMessage({ ...envelope, type: "threw", runId: "r1", message: "boom" })).toEqual({
      channel: ARTIFACT_CHANNEL,
      type: "threw",
      runId: "r1",
      message: "boom",
    });
  });

  it("refuses a throw with nothing to show the pupil", () => {
    expect(asSandboxMessage({ ...envelope, type: "threw", runId: "r1" })).toBeNull();
  });

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

  it("measures the byte bound in bytes, not in UTF-16 units", () => {
    // 40_000 Danish characters is 40_000 units and 80_000 bytes: counted as
    // units it slips past a bound the model is told is 64 KB.
    const message = asStageMessage({
      ...envelope,
      type: "storage",
      runId: "r1",
      area: "local",
      entries: { danish: "æ".repeat(40_000) },
    });

    expect(message?.type === "storage" && Object.keys(message.entries)).toEqual([]);
  });

  it("keeps a key named __proto__ rather than setting a prototype", () => {
    // A computed key, because the literal form is the prototype setter — which
    // is the same reason the snapshot has to be built on a null-prototype map.
    const entries: Record<string, string> = { ["__proto__"]: "12", score: "3" };
    const message = asStageMessage({
      ...envelope,
      type: "storage",
      runId: "r1",
      area: "session",
      entries,
    });

    const kept = message?.type === "storage" ? message.entries : {};
    expect(Object.keys(kept).sort()).toEqual(["__proto__", "score"]);
    expect(Object.getPrototypeOf(kept)).toBeNull();
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
