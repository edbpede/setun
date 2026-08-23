<script lang="ts">
import { superForm } from "sveltekit-superforms";
import { enhance } from "$app/forms";
import * as m from "$lib/paraglide/messages";
import type { PageProps } from "./$types";

/**
 * The alias table (PRD §9, §17).
 *
 * The data-protection flag is shown as a badge on every row, not buried in an
 * edit form: §16 asks that the choice be visible wherever aliases appear, and a
 * flag an educator has to open a form to see is not visible.
 *
 * The gateway identifier is editable here and appears nowhere else in the
 * product — students only ever see the friendly name (§9, §21).
 */
let { data }: PageProps = $props();

// Superforms captures the initial page data and then keeps itself in sync by
// subscribing to page updates internally, so the compiler's warning about a
// locally-referenced value does not apply to this API.
// svelte-ignore state_referenced_locally
const {
  form,
  errors,
  enhance: enhanceCreate,
  submitting,
} = superForm(data.form, {
  resetForm: true,
});

const field = "h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground";
const check = "flex items-center gap-2 text-sm text-foreground";
</script>

<div class="flex flex-col gap-8">
  <section class="flex flex-col gap-3">
    <h1 class="text-base font-semibold text-foreground">{m.educator_aliases_title()}</h1>

    <ul class="flex flex-col divide-y divide-border border-y border-border">
      {#each data.aliases as alias (alias.id)}
        <li class="flex flex-col gap-2 py-3">
          <form
            method="POST"
            action="?/update"
            use:enhance
            class="grid gap-2 sm:grid-cols-[1fr_1fr_auto]"
          >
            <input type="hidden" name="aliasId" value={alias.id} />

            <label class="flex flex-col gap-1">
              <span class="text-xs text-muted-foreground">{m.educator_alias_name_label()}</span>
              <input name="name" value={alias.name} class={field} required />
            </label>

            <label class="flex flex-col gap-1">
              <span class="text-xs text-muted-foreground">{m.educator_alias_gateway_label()}</span>
              <input name="gatewayModelId" value={alias.gatewayModelId} class={field} required />
            </label>

            <label class="flex flex-col gap-1">
              <span class="text-xs text-muted-foreground">{m.educator_alias_dialect_label()}</span>
              <select name="dialect" value={alias.dialect} class={field}>
                <option value="openai">openai</option>
                <option value="anthropic">anthropic</option>
              </select>
            </label>

            <label class="flex flex-col gap-1">
              <span class="text-xs text-muted-foreground">
                {m.educator_alias_input_price_label()}
              </span>
              <input
                name="inputPricePerMillion"
                inputmode="decimal"
                value={alias.inputPricePerMillion ?? ""}
                class={field}
              />
            </label>

            <label class="flex flex-col gap-1">
              <span class="text-xs text-muted-foreground">
                {m.educator_alias_output_price_label()}
              </span>
              <input
                name="outputPricePerMillion"
                inputmode="decimal"
                value={alias.outputPricePerMillion ?? ""}
                class={field}
              />
            </label>

            <div class="flex items-end gap-2">
              <button
                type="submit"
                class="h-9 rounded-md border border-input px-3 text-sm font-medium text-foreground hover:bg-secondary"
              >
                {m.educator_save()}
              </button>
            </div>

            <div class="flex flex-wrap gap-x-5 gap-y-1.5 sm:col-span-3">
              <label class={check}>
                <input type="checkbox" name="available" checked={alias.available} />
                {m.educator_alias_available_label()}
              </label>
              <label class={check}>
                <input type="checkbox" name="dataProtection" checked={alias.dataProtection} />
                {m.educator_alias_dpa_label()}
              </label>
              <label class={check}>
                <input
                  type="checkbox"
                  name="supportsImageInput"
                  checked={alias.supportsImageInput}
                />
                {m.educator_alias_image_input_label()}
              </label>
              <label class={check}>
                <input
                  type="checkbox"
                  name="supportsImageGeneration"
                  checked={alias.supportsImageGeneration}
                />
                {m.educator_alias_image_generation_label()}
              </label>
              <label class={check}>
                <input type="checkbox" name="isUtility" checked={alias.isUtility} />
                {m.educator_alias_utility_label()}
              </label>
            </div>
          </form>

          <div class="flex items-center gap-3">
            <span
              class="rounded-full px-2 py-0.5 text-[0.6875rem] font-medium"
              class:bg-secondary={alias.dataProtection}
              class:text-secondary-foreground={alias.dataProtection}
              class:bg-destructive={!alias.dataProtection}
              class:text-destructive-foreground={!alias.dataProtection}
            >
              {alias.dataProtection
                ? m.educator_alias_dpa_badge()
                : m.educator_alias_no_dpa_badge()}
            </span>

            <form method="POST" action="?/delete" use:enhance>
              <input type="hidden" name="aliasId" value={alias.id} />
              <button type="submit" class="text-xs text-muted-foreground hover:text-destructive">
                {m.educator_allowlist_disallow()}
              </button>
            </form>
          </div>
        </li>
      {/each}
    </ul>
  </section>

  <section class="flex max-w-lg flex-col gap-3 border-t border-border pt-6">
    <h2 class="text-sm font-medium text-foreground">{m.educator_add_alias()}</h2>

    <form method="POST" action="?/create" use:enhanceCreate class="flex flex-col gap-3">
      <label class="flex flex-col gap-1.5">
        <span class="text-sm font-medium text-foreground">{m.educator_alias_name_label()}</span>
        <input name="name" bind:value={$form.name} class={field} required />
        {#if $errors.name}<span class="text-xs text-destructive">{$errors.name}</span>{/if}
      </label>

      <label class="flex flex-col gap-1.5">
        <span class="text-sm font-medium text-foreground">{m.educator_alias_gateway_label()}</span>
        <input name="gatewayModelId" bind:value={$form.gatewayModelId} class={field} required />
        {#if $errors.gatewayModelId}
          <span class="text-xs text-destructive">{$errors.gatewayModelId}</span>
        {/if}
      </label>

      <label class="flex flex-col gap-1.5">
        <span class="text-sm font-medium text-foreground">{m.educator_alias_dialect_label()}</span>
        <select name="dialect" bind:value={$form.dialect} class={field}>
          <option value="openai">openai</option>
          <option value="anthropic">anthropic</option>
        </select>
      </label>

      <div class="flex flex-wrap gap-x-5 gap-y-1.5">
        <label class={check}>
          <input type="checkbox" name="available" bind:checked={$form.available} />
          {m.educator_alias_available_label()}
        </label>
        <label class={check}>
          <input type="checkbox" name="dataProtection" bind:checked={$form.dataProtection} />
          {m.educator_alias_dpa_label()}
        </label>
      </div>

      <button
        type="submit"
        disabled={$submitting}
        class="h-9 self-start rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
      >
        {m.educator_add_alias()}
      </button>
    </form>
  </section>
</div>
