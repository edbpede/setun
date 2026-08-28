<script lang="ts">
import { type SuperValidated, superForm } from "sveltekit-superforms";
import type * as v from "valibot";
import { enhance as formEnhance } from "$app/forms";
import * as m from "$lib/paraglide/messages";
import type { BudgetsSchema } from "$lib/server/classroom/schemas";

/**
 * The three budget layers and the presets that fill them (PRD §10, Appendix A).
 *
 * "Selecting a preset fills all five fields; fields remain individually editable
 * afterwards." So a preset is a submit that writes values and reloads — not a
 * mode the classroom is left in, and not a client-side fill that could disagree
 * with what the server stored.
 *
 * Figures are tokens throughout, because tokens are what the gateway reports and
 * what enforcement is denominated in. The exchange rate sits here too: it is the
 * only display-only number on this form, and it belongs next to what it prices
 * (§10).
 */

type BudgetsData = v.InferOutput<typeof BudgetsSchema>;

interface Props {
  data: SuperValidated<BudgetsData>;
}

let { data }: Props = $props();

// svelte-ignore state_referenced_locally
const { form, errors, enhance, submitting } = superForm(data, {
  id: "budgets",
  /**
   * An edit form, so it must not reset (PRD §8).
   *
   * Superforms resets to the data it was initialised with after a successful
   * submit unless told otherwise, which on a settings form means the teacher
   * types a new value, presses Save, and watches the field snap back to the old
   * one. The write had in fact succeeded; only the screen disagreed, and the
   * natural reading is that saving does not work.
   */
  resetForm: false,
});

const PRESETS = [
  { value: "cautious", label: m.educator_preset_cautious },
  { value: "standard", label: m.educator_preset_standard },
  { value: "generous", label: m.educator_preset_generous },
] as const;

const field = "h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground";
</script>

<section class="flex flex-col gap-3">
  <h2 class="text-sm font-medium text-foreground">{m.educator_budgets_title()}</h2>

  <form
    method="POST"
    action="?/applyPreset"
    use:formEnhance
    class="flex flex-wrap items-end gap-2"
  >
    <label class="flex flex-col gap-1">
      <span class="text-xs text-muted-foreground">{m.educator_preset_label()}</span>
      <select name="preset" class={field}>
        {#each PRESETS as preset (preset.value)}
          <option value={preset.value}>{preset.label()}</option>
        {/each}
      </select>
    </label>
    <button
      type="submit"
      class="h-9 rounded-md border border-input px-3 text-sm font-medium text-foreground hover:bg-secondary"
    >
      {m.educator_apply_preset()}
    </button>
  </form>

  <form
    method="POST"
    action="?/saveBudgets"
    use:enhance
    class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
  >
    <label class="flex flex-col gap-1">
      <span class="text-xs text-muted-foreground">{m.educator_per_turn_steps_label()}</span>
      <input name="perTurnStepCap" type="number" bind:value={$form.perTurnStepCap} class={field} />
      {#if $errors.perTurnStepCap}
        <span class="text-xs text-destructive">{$errors.perTurnStepCap}</span>
      {/if}
    </label>

    <label class="flex flex-col gap-1">
      <span class="text-xs text-muted-foreground">{m.educator_per_turn_seconds_label()}</span>
      <input
        name="perTurnWallClockSeconds"
        type="number"
        bind:value={$form.perTurnWallClockSeconds}
        class={field}
      />
      {#if $errors.perTurnWallClockSeconds}
        <span class="text-xs text-destructive">{$errors.perTurnWallClockSeconds}</span>
      {/if}
    </label>

    <label class="flex flex-col gap-1">
      <span class="text-xs text-muted-foreground">{m.educator_per_turn_tokens_label()}</span>
      <input
        name="perTurnTokenCap"
        type="number"
        bind:value={$form.perTurnTokenCap}
        class={field}
      />
      {#if $errors.perTurnTokenCap}
        <span class="text-xs text-destructive">{$errors.perTurnTokenCap}</span>
      {/if}
    </label>

    <label class="flex flex-col gap-1">
      <span class="text-xs text-muted-foreground">{m.educator_student_daily_label()}</span>
      <input
        name="perStudentDailyTokens"
        type="number"
        bind:value={$form.perStudentDailyTokens}
        class={field}
      />
      {#if $errors.perStudentDailyTokens}
        <span class="text-xs text-destructive">{$errors.perStudentDailyTokens}</span>
      {/if}
    </label>

    <label class="flex flex-col gap-1">
      <span class="text-xs text-muted-foreground">{m.educator_classroom_daily_label()}</span>
      <input
        name="perClassroomDailyTokens"
        type="number"
        bind:value={$form.perClassroomDailyTokens}
        class={field}
      />
      {#if $errors.perClassroomDailyTokens}
        <span class="text-xs text-destructive">{$errors.perClassroomDailyTokens}</span>
      {/if}
    </label>

    <label class="flex flex-col gap-1">
      <span class="text-xs text-muted-foreground">{m.educator_exchange_rate_label()}</span>
      <input
        name="costExchangeRate"
        type="number"
        step="0.01"
        bind:value={$form.costExchangeRate}
        class={field}
      />
      {#if $errors.costExchangeRate}
        <span class="text-xs text-destructive">{$errors.costExchangeRate}</span>
      {/if}
    </label>

    <div class="sm:col-span-2 lg:col-span-3">
      <button
        type="submit"
        disabled={$submitting}
        class="h-9 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
      >
        {m.educator_save()}
      </button>
    </div>
  </form>
</section>
