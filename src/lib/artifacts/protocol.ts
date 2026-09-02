import { isSandboxAssetPath } from "./assets";
import { type ArtifactLanguage, isArtifactLanguage } from "./types";

/**
 * The only channel between the application and the sandbox origin (PRD §14).
 *
 * "Communication with the host page is limited to explicit message passing." So
 * this is the whole vocabulary, and both ends validate every message against it
 * — the sandbox because the application is not its origin, the application
 * because the sandbox runs generated code.
 *
 * The frame is sandboxed without `allow-same-origin`, so its documents have
 * opaque origins and `event.origin` reads `"null"` on everything they send. The
 * identity check that actually holds is therefore `event.source`, which cannot
 * be forged: the application compares against its own iframe's `contentWindow`,
 * and the runner against `window.parent`.
 */

/** Present on every message, so unrelated traffic on the same window is ignored. */
export const ARTIFACT_CHANNEL = "setun-artifact";

/** Application → runner. */
export type HostMessage =
  | {
      readonly channel: typeof ARTIFACT_CHANNEL;
      readonly type: "render";
      readonly runId: string;
      /**
       * Which artifact this run belongs to (§13).
       *
       * The runner keeps a per-artifact snapshot of what the storage shim held,
       * so a game that saved a high score still has it after a Run — and the
       * artifact beside it starts empty rather than reading its neighbour's.
       * Opaque to the sandbox: it is a grouping key and never a lookup.
       */
      readonly artifactId: string;
      readonly language: ArtifactLanguage;
      readonly source: string;
    }
  | { readonly channel: typeof ARTIFACT_CHANNEL; readonly type: "clear" }
  /**
   * Put keyboard focus in the artifact (§13, §20).
   *
   * A canvas game listens on its own `window`, and a pupil who has not clicked
   * inside the frame is typing at the conversation. The application asks rather
   * than the frame taking focus for itself: a frame that grabs focus as it
   * renders steals the composer mid-sentence.
   */
  | { readonly channel: typeof ARTIFACT_CHANNEL; readonly type: "focus" }
  /**
   * An asset the sandbox asked for, fetched from the sandbox origin here.
   *
   * The buffer is transferred rather than copied — the compiler's WebAssembly is
   * thirteen megabytes, and a structured clone of it on every artifact would be
   * a visible pause on the two-core machines this is for (§20).
   */
  | {
      readonly channel: typeof ARTIFACT_CHANNEL;
      readonly type: "asset";
      readonly path: string;
      readonly ok: true;
      readonly bytes: ArrayBuffer;
    }
  | {
      readonly channel: typeof ARTIFACT_CHANNEL;
      readonly type: "asset";
      readonly path: string;
      readonly ok: false;
      readonly message: string;
    };

/** Runner → application. */
export type SandboxMessage =
  | { readonly channel: typeof ARTIFACT_CHANNEL; readonly type: "ready" }
  /** The compiler is being fetched: first non-static artifact of the session (§13). */
  | {
      readonly channel: typeof ARTIFACT_CHANNEL;
      readonly type: "compiling";
      readonly runId: string;
    }
  | { readonly channel: typeof ARTIFACT_CHANNEL; readonly type: "rendered"; readonly runId: string }
  /**
   * The artifact did not build or did not run. The message is the compiler's or
   * the browser's own text, which is what a pupil debugging their code needs;
   * it is rendered as text and never as markup.
   */
  | {
      readonly channel: typeof ARTIFACT_CHANNEL;
      readonly type: "failed";
      readonly runId: string;
      readonly message: string;
    }
  /**
   * A pinned file the sandbox needs and will not fetch for itself (§13, §14).
   *
   * The path is checked against `isSandboxAssetPath` before anything is read, so
   * this asks the application for a file in one of two directories on the
   * sandbox origin and can name nothing else — see `assets.ts` for that bound,
   * and for why the sandbox does not simply fetch the file itself.
   */
  | {
      readonly channel: typeof ARTIFACT_CHANNEL;
      readonly type: "need-asset";
      readonly path: string;
    }
  /**
   * What the artifact printed (§13).
   *
   * A pupil debugging their own loop writes `console.log`, and until now those
   * lines went into a frame nobody could open. Forwarded from the stage, capped
   * at both ends, and rendered as text — it is generated output like any other.
   */
  | {
      readonly channel: typeof ARTIFACT_CHANNEL;
      readonly type: "console";
      readonly runId: string;
      readonly lines: readonly ConsoleLine[];
    };

/** One printed line. The level is a label, not a severity anything acts on. */
export interface ConsoleLine {
  readonly level: "log" | "warn" | "error" | "info" | "debug";
  readonly text: string;
}

export const CONSOLE_LEVELS = ["log", "warn", "error", "info", "debug"] as const;

/** Batch and line caps, applied on both sides of every hop. */
export const CONSOLE_MAX_LINES = 50;
export const CONSOLE_MAX_TEXT = 1_000;

/**
 * The storage shim's caps (§13).
 *
 * A sandboxed frame with no `allow-same-origin` has an opaque origin, and
 * `localStorage` *throws* there rather than returning null — which kills any
 * artifact that saves a score, on the line where it tries. So the document
 * installs an in-memory shim and posts its contents up for the runner to keep;
 * these bound what the runner will hold on the artifact's behalf.
 */
export const STORAGE_AREAS = ["local", "session"] as const;
export type StorageArea = (typeof STORAGE_AREAS)[number];
export const STORAGE_MAX_KEYS = 256;
export const STORAGE_MAX_BYTES = 64 * 1024;

/** What the artifact's own document posts to the runner. */
export type StageMessage =
  | { readonly channel: typeof ARTIFACT_CHANNEL; readonly type: "mounted"; readonly runId: string }
  | {
      readonly channel: typeof ARTIFACT_CHANNEL;
      readonly type: "runtime-error";
      readonly runId: string;
      readonly message: string;
    }
  /**
   * The shim's contents, so a re-run finds them again (§13).
   *
   * It stops at the runner and has no application-facing counterpart on
   * purpose: what an artifact stores is the artifact's, it lives in the sandbox
   * origin's memory for as long as the panel is open, and nothing about it is
   * something Setun should hold.
   */
  | {
      readonly channel: typeof ARTIFACT_CHANNEL;
      readonly type: "storage";
      readonly runId: string;
      readonly area: StorageArea;
      readonly entries: Readonly<Record<string, string>>;
    }
  | {
      readonly channel: typeof ARTIFACT_CHANNEL;
      readonly type: "console";
      readonly runId: string;
      readonly lines: readonly ConsoleLine[];
    };

/** Validate a console batch from either hop, dropping anything malformed. */
export function asConsoleLines(value: unknown): ConsoleLine[] | null {
  if (!Array.isArray(value)) return null;

  const lines: ConsoleLine[] = [];
  for (const entry of value.slice(0, CONSOLE_MAX_LINES)) {
    if (typeof entry !== "object" || entry === null) continue;

    const record = entry as Record<string, unknown>;
    const level = (CONSOLE_LEVELS as readonly string[]).includes(record.level as string)
      ? (record.level as ConsoleLine["level"])
      : "log";
    if (typeof record.text !== "string") continue;

    lines.push({ level, text: record.text.slice(0, CONSOLE_MAX_TEXT) });
  }

  return lines;
}

const UTF8 = new TextEncoder();

/** Encoded length, because the bound is bytes and `.length` counts UTF-16 units. */
function byteLength(value: string): number {
  return UTF8.encode(value).length;
}

/**
 * Validate a storage snapshot: string to string, bounded in count and in bytes.
 *
 * The map has no prototype: `entries.__proto__ = "…"` on an ordinary object
 * invokes the prototype setter, which silently drops a key an artifact stored.
 */
export function asStorageEntries(value: unknown): Record<string, string> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;

  const entries: Record<string, string> = Object.create(null);
  let bytes = 0;

  for (const [key, held] of Object.entries(value as Record<string, unknown>)) {
    if (typeof held !== "string") continue;
    if (Object.keys(entries).length >= STORAGE_MAX_KEYS) break;

    bytes += byteLength(key) + byteLength(held);
    if (bytes > STORAGE_MAX_BYTES) break;

    entries[key] = held;
  }

  return entries;
}

function envelope(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) return null;

  const record = value as Record<string, unknown>;
  return record.channel === ARTIFACT_CHANNEL && typeof record.type === "string" ? record : null;
}

export function asHostMessage(value: unknown): HostMessage | null {
  const record = envelope(value);
  if (!record) return null;

  if (record.type === "clear") return { channel: ARTIFACT_CHANNEL, type: "clear" };
  if (record.type === "focus") return { channel: ARTIFACT_CHANNEL, type: "focus" };

  if (record.type === "asset" && isSandboxAssetPath(record.path)) {
    if (record.ok === true && record.bytes instanceof ArrayBuffer) {
      return {
        channel: ARTIFACT_CHANNEL,
        type: "asset",
        path: record.path,
        ok: true,
        bytes: record.bytes,
      };
    }
    if (record.ok === false) {
      return {
        channel: ARTIFACT_CHANNEL,
        type: "asset",
        path: record.path,
        ok: false,
        message: typeof record.message === "string" ? record.message : "",
      };
    }
    return null;
  }

  if (
    record.type === "render" &&
    typeof record.runId === "string" &&
    typeof record.artifactId === "string" &&
    typeof record.source === "string" &&
    typeof record.language === "string" &&
    isArtifactLanguage(record.language)
  ) {
    return {
      channel: ARTIFACT_CHANNEL,
      type: "render",
      runId: record.runId,
      artifactId: record.artifactId,
      language: record.language,
      source: record.source,
    };
  }

  return null;
}

export function asSandboxMessage(value: unknown): SandboxMessage | null {
  const record = envelope(value);
  if (!record) return null;

  switch (record.type) {
    case "ready":
      return { channel: ARTIFACT_CHANNEL, type: "ready" };
    case "need-asset":
      return isSandboxAssetPath(record.path)
        ? { channel: ARTIFACT_CHANNEL, type: "need-asset", path: record.path }
        : null;
    case "compiling":
    case "rendered":
      return typeof record.runId === "string"
        ? { channel: ARTIFACT_CHANNEL, type: record.type, runId: record.runId }
        : null;
    case "failed":
      return typeof record.runId === "string" && typeof record.message === "string"
        ? {
            channel: ARTIFACT_CHANNEL,
            type: "failed",
            runId: record.runId,
            message: record.message,
          }
        : null;
    case "console": {
      if (typeof record.runId !== "string") return null;
      const lines = asConsoleLines(record.lines);
      return lines
        ? { channel: ARTIFACT_CHANNEL, type: "console", runId: record.runId, lines }
        : null;
    }
    default:
      return null;
  }
}

export function asStageMessage(value: unknown): StageMessage | null {
  const record = envelope(value);
  if (!record || typeof record.runId !== "string") return null;

  if (record.type === "mounted") {
    return { channel: ARTIFACT_CHANNEL, type: "mounted", runId: record.runId };
  }
  if (record.type === "runtime-error") {
    return {
      channel: ARTIFACT_CHANNEL,
      type: "runtime-error",
      runId: record.runId,
      message: typeof record.message === "string" ? record.message : "",
    };
  }

  if (record.type === "storage") {
    if (!(STORAGE_AREAS as readonly unknown[]).includes(record.area)) return null;
    const entries = asStorageEntries(record.entries);
    return entries
      ? {
          channel: ARTIFACT_CHANNEL,
          type: "storage",
          runId: record.runId,
          area: record.area as StorageArea,
          entries,
        }
      : null;
  }

  if (record.type === "console") {
    const lines = asConsoleLines(record.lines);
    return lines
      ? { channel: ARTIFACT_CHANNEL, type: "console", runId: record.runId, lines }
      : null;
  }

  return null;
}
