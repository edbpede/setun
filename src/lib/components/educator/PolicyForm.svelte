<script lang="ts">
import { type SuperValidated, superForm } from "sveltekit-superforms";
import type * as v from "valibot";
import { enhance as formEnhance } from "$app/forms";
import * as m from "$lib/paraglide/messages";
import type { ClassroomPolicySchema } from "$lib/server/classroom/schemas";

/**
 * Instructions, language and session policy (PRD §7, §8, §10).
 *
 * The classroom instructions field is the educator's steering instrument — "the
 * educator's instruments are the layered system prompt, the model allowlist, and
 * classroom availability — steering, not surveillance" (§16). It says plainly
 * that pupils never see it, because an educator writing here should know which
 * of the two it is.
 *
 * Force-logout is a separate form: it takes effect immediately and has nothing
 * to save alongside it (§7, §21).
 */

type PolicyData = v.InferOutput<typeof ClassroomPolicySchema>;

interface Props {
  data: SuperValidated<PolicyData>;
  forceLoggedOut?: number | null;
}

let { data, forceLoggedOut = null }: Props = $props();

// svelte-ignore state_referenced_locally
const { form, errors, enhance, submitting } = superForm(data, { id: "policy" });

const field = "rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground";
</script>

<section class="flex flex-col gap-3">
  <h2 class="text-sm font-medium text-foreground">{m.educator_instructions_title()}</h2>

  <form method="POST" action="?/savePolicy" use:enhance class="flex flex-col gap-4">
    <label class="flex flex-col gap-1.5">
      <span class="text-sm font-medium text-foreground">
        {m.educator_classroom_instructions_label()}
      </span>
      <textarea
        name="classroomInstructions"
        rows="5"
        bind:value={$form.classroomInstructions}
        class={field}
      ></textarea>
      <span class="text-xs text-muted-foreground">
        {m.educator_classroom_instructions_help()}
      </span>
      {#if $errors.classroomInstructions}
        <span class="text-xs text-destructive">{$errors.classroomInstructions}</span>
      {/if}
    </label>

    <div class="grid gap-3 sm:grid-cols-2">
      <label class="flex flex-col gap-1">
        <span class="text-xs text-muted-foreground">{m.educator_interface_language_label()}</span>
        <select name="interfaceLanguage" bind:value={$form.interfaceLanguage} class="h-9 {field}">
          <option value="da">{m.educator_language_da()}</option>
          <option value="en">{m.educator_language_en()}</option>
        </select>
      </label>

      <label class="flex flex-col gap-1">
        <span class="text-xs text-muted-foreground">{m.educator_session_policy_label()}</span>
        <select name="sessionPolicy" bind:value={$form.sessionPolicy} class="h-9 {field}">
          <option value="sliding">{m.educator_session_sliding()}</option>
          <option value="per-lesson">{m.educator_session_per_lesson()}</option>
        </select>
      </label>

      <label class="flex flex-col gap-1">
        <span class="text-xs text-muted-foreground">{m.educator_session_days_label()}</span>
        <input
          name="sessionSlidingDays"
          type="number"
          bind:value={$form.sessionSlidingDays}
          class="h-9 {field}"
        />
        {#if $errors.sessionSlidingDays}
          <span class="text-xs text-destructive">{$errors.sessionSlidingDays}</span>
        {/if}
      </label>

      <label class="flex flex-col gap-1">
        <span class="text-xs text-muted-foreground">{m.educator_retention_days_label()}</span>
        <input
          name="conversationRetentionDays"
          type="number"
          bind:value={$form.conversationRetentionDays}
          class="h-9 {field}"
        />
        {#if $errors.conversationRetentionDays}
          <span class="text-xs text-destructive">{$errors.conversationRetentionDays}</span>
        {/if}
      </label>
    </div>

    <button
      type="submit"
      disabled={$submitting}
      class="h-9 self-start rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
    >
      {m.educator_save()}
    </button>
  </form>
</section>

<section class="flex flex-col gap-2">
  <h2 class="text-sm font-medium text-foreground">{m.educator_sessions_title()}</h2>

  <form method="POST" action="?/forceLogout" use:formEnhance class="flex items-center gap-3">
    <button
      type="submit"
      class="h-9 rounded-md border border-destructive px-3 text-sm font-medium text-destructive hover:bg-destructive hover:text-destructive-foreground"
    >
      {m.educator_force_logout()}
    </button>
    {#if forceLoggedOut !== null}
      <span class="text-xs text-muted-foreground" role="status">
        {m.educator_force_logout_done({ count: forceLoggedOut })}
      </span>
    {/if}
  </form>
</section>
