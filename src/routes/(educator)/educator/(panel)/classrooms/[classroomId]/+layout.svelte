<script lang="ts">
import { page } from "$app/state";
import * as m from "$lib/paraglide/messages";
import type { LayoutProps } from "./$types";

/**
 * The classroom's header and its three tabs (PRD §17).
 *
 * §17 describes the panel as "a dense, single-operator tool" whose classroom
 * area covers configuration, roster and provisioning. One page carrying all of
 * that would be a scroll rather than a tool, so it is three: what is happening
 * now, what the class is allowed to do, and who is in it.
 */
let { data, children }: LayoutProps = $props();

const base = $derived(`/educator/classrooms/${data.classroom.id}`);
const current = $derived(page.url.pathname);

const tabs = $derived([
  { href: base, label: m.educator_nav_overview() },
  { href: `${base}/settings`, label: m.educator_nav_settings() },
  { href: `${base}/roster`, label: m.educator_nav_roster() },
]);
</script>

<svelte:head><title>{data.classroom.name} · {m.educator_panel_title()}</title></svelte:head>

<div class="flex flex-col gap-6">
  <header class="flex flex-col gap-2">
    <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <h1 class="text-base font-semibold text-foreground">{data.classroom.name}</h1>
      <span class="text-xs text-muted-foreground">{data.classroom.timezone}</span>
    </div>

    <nav class="flex gap-1 border-b border-border">
      {#each tabs as tab (tab.href)}
        <a
          href={tab.href}
          class="-mb-px border-b-2 px-3 py-1.5 text-sm"
          class:border-primary={current === tab.href}
          class:font-medium={current === tab.href}
          class:text-foreground={current === tab.href}
          class:border-transparent={current !== tab.href}
          class:text-muted-foreground={current !== tab.href}
        >
          {tab.label}
        </a>
      {/each}
    </nav>
  </header>

  {@render children()}
</div>
