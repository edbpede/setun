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
      readonly language: ArtifactLanguage;
      readonly source: string;
    }
  | { readonly channel: typeof ARTIFACT_CHANNEL; readonly type: "clear" }
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
    };

/** What the artifact's own document posts to the runner. */
export type StageMessage =
  | { readonly channel: typeof ARTIFACT_CHANNEL; readonly type: "mounted"; readonly runId: string }
  | {
      readonly channel: typeof ARTIFACT_CHANNEL;
      readonly type: "runtime-error";
      readonly runId: string;
      readonly message: string;
    };

function envelope(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) return null;

  const record = value as Record<string, unknown>;
  return record.channel === ARTIFACT_CHANNEL && typeof record.type === "string" ? record : null;
}

export function asHostMessage(value: unknown): HostMessage | null {
  const record = envelope(value);
  if (!record) return null;

  if (record.type === "clear") return { channel: ARTIFACT_CHANNEL, type: "clear" };

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
    typeof record.source === "string" &&
    typeof record.language === "string" &&
    isArtifactLanguage(record.language)
  ) {
    return {
      channel: ARTIFACT_CHANNEL,
      type: "render",
      runId: record.runId,
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

  return null;
}
