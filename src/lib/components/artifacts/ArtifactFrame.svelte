<script lang="ts">
import { ARTIFACT_CHANNEL, asSandboxMessage, type HostMessage } from "$lib/artifacts/protocol";
import type { ArtifactLanguage } from "$lib/artifacts/types";
import * as m from "$lib/paraglide/messages";

/**
 * The sandboxed iframe host and its message bridge (PRD §14).
 *
 * "Artifacts execute on a separate origin from the application, in an iframe
 * sandboxed to allow scripts but explicitly *not* same-origin." Dropping
 * `allow-same-origin` gives the frame an opaque origin: it cannot read this
 * page's cookies, storage or DOM even though the URL it loads is one this
 * deployment serves.
 *
 * A consequence worth naming, because it looks like a mistake: every message
 * from the frame arrives with `event.origin === "null"`, so origin checking is
 * useless here and `event.source` is the identity that actually holds — it is a
 * window reference this component created and no other page can forge.
 */

interface Props {
  /** A distinct hostname from the application's; isolation is by origin (§14). */
  sandboxOrigin: string;
  language: ArtifactLanguage;
  /** The source to run. Advanced only at a commit point, never per keystroke (§13). */
  source: string;
  oncompiling?: () => void;
  onrunning?: () => void;
  onfailed?: (message: string) => void;
}

let { sandboxOrigin, language, source, oncompiling, onrunning, onfailed }: Props = $props();

let frame = $state<HTMLIFrameElement | null>(null);
let ready = $state(false);

/** Plain, not reactive: it is only ever read inside an event callback. */
let currentRunId: string | null = null;

function send(message: HostMessage): void {
  // `"*"` because the frame has an opaque origin, which has no addressable
  // form. Nothing secret travels this way — the artifact already has its source.
  frame?.contentWindow?.postMessage(message, "*");
}

$effect(() => {
  function receive(event: MessageEvent): void {
    if (!frame?.contentWindow || event.source !== frame.contentWindow) return;

    const message = asSandboxMessage(event.data);
    if (!message) return;

    if (message.type === "ready") {
      ready = true;
      return;
    }
    // A late answer from a superseded run would report the wrong revision.
    if (message.runId !== currentRunId) return;

    if (message.type === "compiling") oncompiling?.();
    else if (message.type === "rendered") onrunning?.();
    else onfailed?.(message.message);
  }

  window.addEventListener("message", receive);
  return () => window.removeEventListener("message", receive);
});

// Runs when the frame reports ready and whenever the committed source changes.
$effect(() => {
  const running = source;
  const kind = language;
  if (!ready) return;

  currentRunId = crypto.randomUUID();
  send({
    channel: ARTIFACT_CHANNEL,
    type: "render",
    runId: currentRunId,
    language: kind,
    source: running,
  });
});
</script>

<iframe
  bind:this={frame}
  src={sandboxOrigin}
  title={m.artifact_frame_title()}
  sandbox="allow-scripts"
  referrerpolicy="no-referrer"
  allow=""
  class="h-full w-full border-0 bg-white"
></iframe>
