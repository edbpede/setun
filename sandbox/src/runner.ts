import {
  FRAMEWORK_ENTRIES,
  isRuntimeManifest,
  type RuntimeManifest,
  SANDBOX_MANIFEST_PATH,
  UNOCSS_ENTRY,
} from "$lib/artifacts/assets";
import {
  type ArtifactStorageSeed,
  compiledDocument,
  type RuntimeSources,
  staticDocument,
} from "$lib/artifacts/document";
import {
  ARTIFACT_CHANNEL,
  asHostMessage,
  asStageMessage,
  type SandboxMessage,
} from "$lib/artifacts/protocol";
import { type ArtifactLanguage, tierOf } from "$lib/artifacts/types";
import type { CompileRequest, CompileResponse, WorkerResponse } from "./compile-protocol";

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

/** The render currently on screen; results from earlier ones are dropped. */
let currentRunId: string | null = null;
/**
 * Which word a run has already said, so the first terminal one wins (§13).
 *
 * A page that mounts and then throws — a click handler with a typo, a timer that
 * divides by nothing — is on the pupil's screen, and reporting that as `failed`
 * told the model a working artifact never ran at all, which is answered by a
 * rewrite rather than by a fix. So an error is `threw` once its run has acked
 * its mount, and `failed` before that; and a `mounted` arriving *after* a
 * failure is dropped, because a document that threw on its way up can still
 * finish parsing and ack.
 */
let mountedRunId: string | null = null;
let failedRunId: string | null = null;
/**
 * Which artifact each staged document belongs to, newest last.
 *
 * Replacing the stage's document fires `pagehide` in the old one, and the shim
 * flushes there — with the run id it was started under, from a window the frame
 * no longer holds. Both of those made the flush unrecognisable: it named a run
 * that was no longer current, and it came from a source that was no longer
 * `stage.contentWindow`. So every write made inside the shim's 250 ms debounce
 * was lost whenever a pupil pressed Run, which for a game is its saved state.
 *
 * A map rather than a single slot for the run just replaced: renders overlap, so
 * the document on screen can be several runs behind the current one, and its
 * last word is the one that matters. Filled where a document is *staged*, since
 * a run whose result was discarded mid-compile never had one and can never post
 * anything. Bounded, like the snapshots it places.
 */
const STAGED_RUNS_KEPT = 8;
const artifactByRun = new Map<string, string>();

function stageDocument(runId: string, artifactId: string, srcdoc: string): void {
  artifactByRun.set(runId, artifactId);
  while (artifactByRun.size > STAGED_RUNS_KEPT) {
    const oldest = artifactByRun.keys().next().value;
    if (oldest === undefined) break;
    artifactByRun.delete(oldest);
  }

  stage.srcdoc = srcdoc;
}

/**
 * What each artifact's storage shim held, kept for as long as this page lives
 * (PRD §13).
 *
 * The artifact's own frame has an opaque origin, where `localStorage` throws, so
 * the document installs an in-memory stand-in and posts its contents here. This
 * is where "survives a Run" comes from — and where "the artifact beside it starts
 * empty" comes from, since the snapshots are keyed by artifact.
 *
 * It stops here. Nothing about it is posted to the application: what an artifact
 * stores is the artifact's, it is not durable, and the model is told as much.
 * Bounded so a lesson that opens twenty artifacts does not accumulate all of
 * them; the oldest goes first, which is the one nobody is looking at.
 */
const MAX_STORAGE_SNAPSHOTS = 16;
const storageByArtifact = new Map<
  string,
  { local: Record<string, string>; session: Record<string, string> }
>();

function storageFor(artifactId: string): ArtifactStorageSeed {
  const held = storageByArtifact.get(artifactId);
  if (!held) return { local: {}, session: {} };

  // Reading is use. Without this a rerun that writes nothing never refreshes
  // its recency, and the artifact on screen is the next one evicted.
  storageByArtifact.delete(artifactId);
  storageByArtifact.set(artifactId, held);

  return held;
}

/** Which artifact a snapshot belongs to — any document this page has staged. */
function storageOwnerOf(runId: string): string | null {
  return artifactByRun.get(runId) ?? null;
}

function rememberStorage(
  artifactId: string,
  area: "local" | "session",
  entries: Record<string, string>,
): void {
  const held = storageByArtifact.get(artifactId) ?? { local: {}, session: {} };
  held[area] = entries;

  // Re-inserted so the map's insertion order is recency, which is what makes
  // "drop the oldest" mean "drop the one nobody has run in longest".
  storageByArtifact.delete(artifactId);
  storageByArtifact.set(artifactId, held);

  while (storageByArtifact.size > MAX_STORAGE_SNAPSHOTS) {
    const oldest = storageByArtifact.keys().next().value;
    if (oldest === undefined) break;
    storageByArtifact.delete(oldest);
  }
}

let worker: Promise<Worker> | null = null;
const pending = new Map<string, (response: CompileResponse) => void>();

/**
 * The pinned files, brokered from the application and kept for the session.
 *
 * This page may not fetch them: its origin is opaque, which is the one position
 * from which the sandbox host is hardest to read — see
 * `src/lib/artifacts/assets.ts`. So it asks the application, which is an
 * ordinary origin and for which the same GET is unremarkable, and everything
 * below here — the compiler worker and the artifact's own document — is served
 * from this one place rather than reaching out on its own.
 *
 * Cached as promises, so two artifacts opened together share one request; a
 * failed one is dropped so the next attempt is a real retry rather than a replay
 * of the first failure.
 */
const assets = new Map<string, Promise<ArrayBuffer>>();
const awaitingAsset = new Map<string, (result: AssetResult) => void>();

type AssetResult = { ok: true; bytes: ArrayBuffer } | { ok: false; message: string };

function asset(path: string): Promise<ArrayBuffer> {
  const held = assets.get(path);
  if (held) return held;

  const wanted = new Promise<ArrayBuffer>((resolve, reject) => {
    awaitingAsset.set(path, (result) => {
      if (result.ok) resolve(result.bytes);
      else reject(new Error(result.message || `The sandbox could not load ${path}.`));
    });
    toHost({ channel: ARTIFACT_CHANNEL, type: "need-asset", path });
  }).catch((cause: unknown) => {
    assets.delete(path);
    throw cause;
  });

  assets.set(path, wanted);
  return wanted;
}

async function assetText(path: string): Promise<string> {
  return new TextDecoder().decode(await asset(path));
}

/**
 * What the build published about its own output, read once per session.
 *
 * The runtimes are a code-split graph whose shared chunks carry build hashes, so
 * nothing here can know their names in advance — the manifest is what does.
 */
let manifestPromise: Promise<RuntimeManifest> | null = null;

function manifest(): Promise<RuntimeManifest> {
  manifestPromise ??= assetText(SANDBOX_MANIFEST_PATH)
    .then((text) => {
      const parsed: unknown = JSON.parse(text);
      if (!isRuntimeManifest(parsed)) throw new Error("The runtime manifest is not readable.");
      return parsed;
    })
    .catch((cause: unknown) => {
      manifestPromise = null;
      throw cause;
    });

  return manifestPromise;
}

/**
 * The module graph one document carries, for one framework.
 *
 * An entry brings its transitive chunks with it, because a graph with a hole in
 * it does not load, and only the entries that framework needs are collected: a
 * React lesson never carries Svelte (§20).
 *
 * UnoCSS is best-effort and always wanted. A document that renders without its
 * utility classes is worse-looking, not broken, so a failure here is swallowed
 * rather than failing the run.
 */
async function runtimeSources(framework: "react" | "svelte" | null): Promise<RuntimeSources> {
  // A static artifact needs nothing from here that it cannot do without, so a
  // manifest it cannot read must not be the reason an HTML page fails to render.
  const table = await (framework ? manifest() : manifest().catch(() => null));
  if (!table) return { modules: {}, imports: {} };

  const modules: Record<string, string> = {};
  const imports: Record<string, string> = {};
  const sideEffects: string[] = [];

  const collect = async (name: string): Promise<void> => {
    const entry = table.entries[name];
    if (!entry) throw new Error(`The sandbox has no runtime called ${name}.`);

    await Promise.all([
      assetText(entry.file).then((source) => {
        modules[name] = source;
      }),
      ...entry.needs.map(async (chunk) => {
        const file = table.chunks[chunk];
        if (!file) throw new Error(`The runtime manifest does not place ${chunk}.`);
        modules[chunk] = await assetText(file);
        // A chunk is imported by the name the build rewrote it to, so it has to
        // be in the map as well as in the sources.
        imports[chunk] = chunk;
      }),
    ]);
  };

  const wanted = framework ? [...FRAMEWORK_ENTRIES[framework]] : [];
  const utility = collect(UNOCSS_ENTRY).then(
    () => {
      imports[UNOCSS_ENTRY] = UNOCSS_ENTRY;
      sideEffects.push(UNOCSS_ENTRY);
    },
    () => {},
  );

  await Promise.all([utility, ...wanted.map(collect)]);

  for (const [specifier, name] of Object.entries(table.specifiers)) {
    if (modules[name]) imports[specifier] = name;
  }

  return { modules, imports, sideEffects };
}

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

    started.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const message = event.data;

      // The worker cannot fetch either — it was built from a blob and shares this
      // document's opaque origin — so its asks pass through the same broker.
      if (message.kind === "need-asset") {
        void asset(message.path).then(
          (bytes) => {
            // Transferred, not copied: the compiler's WebAssembly is thirteen
            // megabytes and a structured clone of it is a visible pause on the
            // machines this is for (§20). Transfer detaches the buffer here, so
            // the cache entry goes with it — a later ask is then a real request
            // rather than a replay of a husk.
            assets.delete(message.path);
            started.postMessage({ kind: "asset", path: message.path, ok: true, bytes }, [bytes]);
          },
          (cause: unknown) =>
            started.postMessage({
              kind: "asset",
              path: message.path,
              ok: false,
              message: cause instanceof Error ? cause.message : String(cause),
            }),
        );
        return;
      }

      const resolve = pending.get(message.id);
      pending.delete(message.id);
      resolve?.(message);
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
    started.postMessage({ kind: "compile", ...request });
  });
}

async function render(
  runId: string,
  artifactId: string,
  language: ArtifactLanguage,
  source: string,
): Promise<void> {
  currentRunId = runId;
  mountedRunId = null;
  failedRunId = null;

  // Read before the awaits below: the shim is seeded with what this artifact
  // held, and a snapshot arriving mid-render belongs to the document being
  // replaced rather than to the one being built.
  const storage = storageFor(artifactId);

  if (tierOf(language) === 0) {
    const runtimes = await runtimeSources(null);

    // Collecting the runtimes is a round-trip through the application, so a
    // later render may have staged its document while this one waited — the
    // same reason the compiled path below rechecks before it assigns.
    if (currentRunId !== runId) return;

    stageDocument(
      runId,
      artifactId,
      staticDocument({ language: language as "html" | "svg", source, runtimes, runId, storage }),
    );
    return;
  }

  toHost({ channel: ARTIFACT_CHANNEL, type: "compiling", runId });

  const framework = language === "svelte" ? "svelte" : "react";
  // Compiling and collecting the runtimes at once: neither needs the other, and
  // on a two-core machine the compile is the long pole either way (§20).
  const [result, runtimes] = await Promise.all([
    compile({ id: runId, language: language as "jsx" | "tsx" | "svelte", source }),
    runtimeSources(framework),
  ]);

  // A later render started while this one compiled; its document is the one on
  // screen, and overwriting it with this result would show the wrong revision.
  if (currentRunId !== runId) return;

  if (!result.ok) {
    stage.srcdoc = "";
    failedRunId = runId;
    toHost({ channel: ARTIFACT_CHANNEL, type: "failed", runId, message: result.message });
    return;
  }

  stageDocument(
    runId,
    artifactId,
    compiledDocument({ framework, module: result.code, runtimes, runId, storage }),
  );
}

window.addEventListener("message", (event) => {
  // From the artifact below — which is anything that is not the application
  // above. The frame's *current* window is not the test: a document being torn
  // down posts its final storage snapshot from `pagehide`, and by then the
  // browser has swapped `stage.contentWindow` for the document replacing it.
  if (event.source !== parent) {
    const staged = asStageMessage(event.data);
    if (!staged) return;

    // Kept here and forwarded no further: what an artifact stores belongs to
    // the artifact, and the application has no use for it (§13, §14).
    //
    // Placed by the run it names rather than by its sender, which is what lets
    // the replaced document's last word still count. A run id is minted by the
    // application per render, so it names a document this page staged itself.
    if (staged.type === "storage") {
      const owner = storageOwnerOf(staged.runId);
      if (owner) rememberStorage(owner, staged.area, { ...staged.entries });
      return;
    }

    // Everything else describes what is on screen, so it has to come from the
    // document that is on screen and name the run that is running in it.
    if (event.source !== stage.contentWindow || staged.runId !== currentRunId) return;

    if (staged.type === "console") {
      toHost({
        channel: ARTIFACT_CHANNEL,
        type: "console",
        runId: staged.runId,
        lines: staged.lines,
      });
      return;
    }

    if (staged.type === "mounted") {
      // A run that already reported a failure has said its word; the document
      // finishing its parse afterwards does not take it back.
      if (staged.runId === failedRunId) return;

      mountedRunId = staged.runId;
      toHost({ channel: ARTIFACT_CHANNEL, type: "rendered", runId: staged.runId });
      // A game listens for keys on its own window, and a pupil who has not
      // clicked inside the frame is typing at the conversation. Taken only when
      // this page already holds focus, so a render that lands while the pupil is
      // writing does not pull the caret out of the composer.
      if (document.hasFocus()) stage.contentWindow?.focus();
      return;
    }

    // Named rather than a fall-through: a future stage message would otherwise
    // be reported to the application as this artifact having failed.
    if (staged.type === "runtime-error") {
      if (staged.runId === mountedRunId) {
        toHost({
          channel: ARTIFACT_CHANNEL,
          type: "threw",
          runId: staged.runId,
          message: staged.message,
        });
        return;
      }

      failedRunId = staged.runId;
      toHost({
        channel: ARTIFACT_CHANNEL,
        type: "failed",
        runId: staged.runId,
        message: staged.message,
      });
    }
    return;
  }

  const message = asHostMessage(event.data);
  if (!message) return;

  if (message.type === "asset") {
    const settle = awaitingAsset.get(message.path);
    awaitingAsset.delete(message.path);
    settle?.(
      message.ok ? { ok: true, bytes: message.bytes } : { ok: false, message: message.message },
    );
    return;
  }

  if (message.type === "clear") {
    // The document on screen is torn down here too, and `artifactByRun` still
    // holds its owner — so its final flush lands like any other.
    currentRunId = null;
    stage.srcdoc = "";
    return;
  }

  // The application asking for the artifact to take the keyboard: a pupil who
  // tapped the preview means to play the game, not to type into the composer.
  if (message.type === "focus") {
    stage.contentWindow?.focus();
    return;
  }

  // Nothing here may fail silently: a rejected render would leave the panel
  // waiting on a build that is never coming, with nothing to tell the pupil.
  void render(message.runId, message.artifactId, message.language, message.source).catch(
    (cause) => {
      failedRunId = message.runId;
      toHost({
        channel: ARTIFACT_CHANNEL,
        type: "failed",
        runId: message.runId,
        message: cause instanceof Error ? cause.message : String(cause),
      });
    },
  );
});

toHost({ channel: ARTIFACT_CHANNEL, type: "ready" });
