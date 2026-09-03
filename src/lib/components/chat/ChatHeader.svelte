<script lang="ts">
import PanelLeft from "@lucide/svelte/icons/panel-left";
import AllowanceMeter from "$lib/components/classroom/AllowanceMeter.svelte";
import WorkspaceSwitcher from "$lib/components/workspace/WorkspaceSwitcher.svelte";
import * as m from "$lib/paraglide/messages";
import type { AllowanceStatus } from "$lib/server/classroom/status";
import type { WorkspaceStage } from "$lib/state/artifacts.svelte";
import type { SplitAxis } from "$lib/workspace/axis";

/**
 * The one strip of chrome the workspace has (PRD §20).
 *
 * "Usable height on the target device is roughly 640 pixels, so there is no
 * persistent application header" — so this is as close to none as the page can
 * get: what you are in, what you can spend, and what is on screen. Everything
 * else is in the drawer.
 *
 * The switcher is the strip's one primary control and sits on the end, where the
 * thing it governs is.
 *
 * The type import is erased at compile time, so no server code enters the bundle.
 */
interface Props {
  title: string;
  drawerOpen: boolean;
  ondrawer: () => void;
  allowance: AllowanceStatus;
  stage: WorkspaceStage;
  axis: SplitAxis;
  unseen: boolean;
  buildCount: number;
  onstage: (stage: WorkspaceStage) => void;
}

let { title, drawerOpen, ondrawer, allowance, stage, axis, unseen, buildCount, onstage }: Props =
  $props();
</script>

<header
  class="flex shrink-0 items-center gap-2 border-b border-border bg-background px-2 py-1.5 sm:px-3"
>
  <button
    type="button"
    onclick={ondrawer}
    aria-expanded={drawerOpen}
    aria-label={m.chat_conversations()}
    class="grid size-9 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
  >
    <PanelLeft size={17} aria-hidden="true" />
  </button>

  <h1 class="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{title}</h1>

  <!-- Quiet, and never in the way of the composer it sits above (§10, §18). -->
  <div class="hidden w-44 shrink-0 lg:block">
    <AllowanceMeter {allowance} compact />
  </div>

  <WorkspaceSwitcher {stage} {axis} {unseen} count={buildCount} {onstage} />
</header>
