<script lang="ts">
import Monitor from "@lucide/svelte/icons/monitor";
import Moon from "@lucide/svelte/icons/moon";
import Sun from "@lucide/svelte/icons/sun";
import { rovingTarget } from "$lib/a11y/roving";
import * as m from "$lib/paraglide/messages";
import { getTheme, THEME_PREFERENCES, type ThemePreference } from "$lib/state/theme.svelte";

/**
 * Light, follow the device, or dark (PRD §20).
 *
 * Three genuine values, so three positions rather than a switch that hides one
 * of them. A radio group, because exactly one is true at a time.
 *
 * The preference is a device setting rather than an account one: it is stored in
 * this browser and reaches neither the server nor another pupil's Chromebook, so
 * nothing about how a pupil likes to read is recorded against them (§16).
 */
const theme = getTheme();

const labels: Record<ThemePreference, string> = $derived({
  light: m.theme_light(),
  auto: m.theme_auto(),
  dark: m.theme_dark(),
});

const icons = { light: Sun, auto: Monitor, dark: Moon };

let group = $state<HTMLDivElement | null>(null);

/**
 * One tab stop, and the arrows move within it.
 *
 * The same contract the workspace switcher keeps, and for the same reason:
 * three tabbable buttons cost a keyboard user three stops on the way past a
 * setting they are usually not looking for, and roving `tabindex` without arrow
 * handling would leave two of the three unreachable altogether.
 */
function onkeydown(event: KeyboardEvent): void {
  const next = rovingTarget(event, {
    values: THEME_PREFERENCES,
    current: theme.preference,
    attribute: "data-preference",
  });
  if (!next) return;

  event.preventDefault();
  theme.set(next);

  // The moved-to radio takes focus, so the next arrow press continues from it.
  queueMicrotask(() => {
    group?.querySelector<HTMLElement>(`[data-preference="${next}"]`)?.focus();
  });
}
</script>

<div
  bind:this={group}
  role="radiogroup"
  aria-label={m.theme_label()}
  tabindex="-1"
  {onkeydown}
  class="flex items-center gap-0.5 rounded-lg border border-border p-0.5"
>
  {#each THEME_PREFERENCES as candidate (candidate)}
    {@const Icon = icons[candidate]}
    {@const active = theme.preference === candidate}
    <button
      type="button"
      role="radio"
      data-preference={candidate}
      aria-checked={active}
      aria-label={labels[candidate]}
      title={labels[candidate]}
      tabindex={active ? 0 : -1}
      onclick={() => theme.set(candidate)}
      class={[
        "grid h-8 flex-1 place-items-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        active
          ? "bg-primary/10 text-primary"
          : "text-muted-foreground hover:bg-secondary hover:text-foreground",
      ]}
    >
      <Icon size={15} aria-hidden="true" />
    </button>
  {/each}
</div>
