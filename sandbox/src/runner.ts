import { compiledDocument, staticDocument } from "$lib/artifacts/document";
import {
  ARTIFACT_CHANNEL,
  asHostMessage,
  asStageMessage,
  type SandboxMessage,
} from "$lib/artifacts/protocol";
import { type ArtifactLanguage, tierOf } from "$lib/artifacts/types";
import type { CompileRequest, CompileResponse } from "./compile-protocol";

/**
 * The bridge between the application and generated code (PRD §13, §14).
 *
 * Two boundaries meet here and neither is crossed by anything but messages.
 * Above: the application, on its own origin, which this page reaches only
 * through `postMessage` — and which it identifies by `event.source`, because
 * this document's origin is opaque and every origin it reads is `"null"`.
 * Below: the artifact, in a nested frame with an opaque origin of its own, so
 * it cannot reach this script even though this script writes its document.
 */

const stage = document.getElementById("stage") as HTMLIFrameElement;
const origin = location.origin;

/** The render currently on screen; results from earlier ones are dropped. */
let currentRunId: string | null = null;

let worker: Promise<Worker> | null = null;
const pending = new Map<string, (response: CompileResponse) => void>();

function toHost(message: SandboxMessage): void {
  // The application verifies `event.source` against its own frame, which is what
  // actually identifies this page; the target origin is `"*"` because an opaque
  // origin has no other addressable form.
  parent.postMessage(message, "*");
}

/**
 * The compiler, started on the first non-static artifact and kept afterwards.
 *
 * Behind a dynamic import so that a lesson which only builds HTML never fetches
 * it at all — "the compiler is fetched only when a student first opens a
 * non-static artifact, and cached thereafter" (§13, §20).
 *
 * A cross-origin worker script is refused outright from an opaque origin, so the
 * bundle is inlined and constructed from a blob — which is same-origin with this
 * document by definition (§13, §14).
 */
function compiler(): Promise<Worker> {
  worker ??= import("./compiler.worker?worker&inline").then(({ default: CompilerWorker }) => {
    const started = new CompilerWorker();

    started.onmessage = (event: MessageEvent<CompileResponse>) => {
      const resolve = pending.get(event.data.id);
      pending.delete(event.data.id);
      resolve?.(event.data);
    };

    // A worker that fails to start reports here and nowhere else; without this
    // every waiting compile would hang on a promise that never settles.
    started.onerror = (event) => {
      const message = typeof event === "string" ? event : (event.message ?? "compiler failed");
      for (const [id, resolve] of pending) resolve({ id, ok: false, message });
      pending.clear();
    };

    return started;
  });

  return worker;
}

async function compile(request: CompileRequest): Promise<CompileResponse> {
  const started = await compiler();

  return new Promise((resolve) => {
    pending.set(request.id, resolve);
    started.postMessage(request);
  });
}

async function render(runId: string, language: ArtifactLanguage, source: string): Promise<void> {
  currentRunId = runId;

  if (tierOf(language) === 0) {
    stage.srcdoc = staticDocument({
      language: language as "html" | "svg",
      source,
      origin,
      runId,
    });
    return;
  }

  toHost({ channel: ARTIFACT_CHANNEL, type: "compiling", runId });

  const result = await compile({
    id: runId,
    origin,
    language: language as "jsx" | "tsx" | "svelte",
    source,
  });

  // A later render started while this one compiled; its document is the one on
  // screen, and overwriting it with this result would show the wrong revision.
  if (currentRunId !== runId) return;

  if (!result.ok) {
    stage.srcdoc = "";
    toHost({ channel: ARTIFACT_CHANNEL, type: "failed", runId, message: result.message });
    return;
  }

  stage.srcdoc = compiledDocument({
    framework: language === "svelte" ? "svelte" : "react",
    module: result.code,
    origin,
    runId,
  });
}

window.addEventListener("message", (event) => {
  // From the artifact below: mounted, or an error it threw at runtime.
  if (stage.contentWindow && event.source === stage.contentWindow) {
    const staged = asStageMessage(event.data);
    if (!staged || staged.runId !== currentRunId) return;

    toHost(
      staged.type === "mounted"
        ? { channel: ARTIFACT_CHANNEL, type: "rendered", runId: staged.runId }
        : {
            channel: ARTIFACT_CHANNEL,
            type: "failed",
            runId: staged.runId,
            message: staged.message,
          },
    );
    return;
  }

  // From the application above. Anything else on this window is ignored.
  if (event.source !== parent) return;

  const message = asHostMessage(event.data);
  if (!message) return;

  if (message.type === "clear") {
    currentRunId = null;
    stage.srcdoc = "";
    return;
  }

  // Nothing here may fail silently: a rejected render would leave the panel
  // waiting on a build that is never coming, with nothing to tell the pupil.
  void render(message.runId, message.language, message.source).catch((cause) => {
    toHost({
      channel: ARTIFACT_CHANNEL,
      type: "failed",
      runId: message.runId,
      message: cause instanceof Error ? cause.message : String(cause),
    });
  });
});

toHost({ channel: ARTIFACT_CHANNEL, type: "ready" });
