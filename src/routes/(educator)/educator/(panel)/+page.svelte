<script lang="ts">
import { superForm } from "sveltekit-superforms";
import * as m from "$lib/paraglide/messages";
import type { PageProps } from "./$types";

/**
 * Create a classroom, and the gateway's state (PRD §9, §17).
 *
 * The gateway line says exactly two things — answering or not, and how many
 * models — because that is all an educator can act on, and everything else
 * would be infrastructure detail (§9, §21).
 */
let { data }: PageProps = $props();

// Superforms captures the initial page data and then keeps itself in sync by
// subscribing to page updates internally, so the compiler's warning about a
// locally-referenced value does not apply to this API.
// svelte-ignore state_referenced_locally
const { form, errors, enhance, submitting } = superForm(data.form);
</script>

<div class="flex max-w-lg flex-col gap-8">
  <section class="flex flex-col gap-3">
    <h1 class="text-base font-semibold text-foreground">{m.educator_create_classroom()}</h1>

    <form method="POST" action="?/create" use:enhance class="flex flex-col gap-3">
      <label class="flex flex-col gap-1.5">
        <span class="text-sm font-medium text-foreground">{m.educator_classroom_name_label()}</span>
        <input
          name="name"
          bind:value={$form.name}
          required
          class="h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground"
        />
        {#if $errors.name}<span class="text-xs text-destructive">{$errors.name}</span>{/if}
      </label>

      <label class="flex flex-col gap-1.5">
        <span class="text-sm font-medium text-foreground">{m.educator_timezone_label()}</span>
        <input
          name="timezone"
          bind:value={$form.timezone}
          class="h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground"
        />
        {#if $errors.timezone}<span class="text-xs text-destructive">{$errors.timezone}</span>{/if}
      </label>

      <button
        type="submit"
        disabled={$submitting}
        class="h-9 self-start rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
      >
        {m.educator_create_classroom()}
      </button>
    </form>
  </section>

  <section class="flex flex-col gap-1.5 border-t border-border pt-6">
    <h2 class="text-sm font-medium text-foreground">{m.educator_gateway_health_title()}</h2>
    <p class="text-sm" class:text-muted-foreground={data.gateway.reachable} class:text-destructive={!data.gateway.reachable}>
      {#if data.gateway.reachable}
        {m.educator_gateway_reachable({ count: data.gateway.modelCount })}
      {:else}
        {m.educator_gateway_unreachable()}
      {/if}
    </p>
  </section>
</div>
