<script lang="ts">
import { type SuperValidated, superForm } from "sveltekit-superforms";
import type * as v from "valibot";
import * as m from "$lib/paraglide/messages";
import type { SetupEducatorSchema } from "$lib/server/setup/schemas";

/**
 * Step 1 — the operator account (PRD §7).
 *
 * The one credential in Setun with no reset path: "there is no in-application
 * password recovery — a forgotten educator password is reset by re-seeding the
 * credential in deployment configuration and restarting". The intro says so
 * plainly, and the confirmation field exists because a password typed wrong
 * twice is the failure mode that sentence describes.
 *
 * The step is not rendered at all when the account comes from deployment
 * configuration; the server refuses it independently.
 */

type EducatorData = v.InferOutput<typeof SetupEducatorSchema>;

interface Props {
  data: SuperValidated<EducatorData>;
  /** The server's own floor, handed down rather than restated here. */
  minLength: number;
}

let { data, minLength }: Props = $props();

// Superforms captures the initial page data and keeps itself in sync internally.
// svelte-ignore state_referenced_locally
const { form, errors, enhance, submitting } = superForm(data, { id: "setup-educator" });

const field = "h-10 rounded-md border border-input bg-background px-3 text-sm text-foreground";
</script>

<section class="flex flex-col gap-3">
  <h2 class="text-sm font-medium text-foreground">{m.setup_educator_title()}</h2>
  <p class="text-sm text-muted-foreground">{m.setup_educator_intro()}</p>

  <form method="POST" action="?/educator" use:enhance class="flex flex-col gap-3">
    <label class="flex flex-col gap-1.5">
      <span class="text-sm font-medium text-foreground">{m.educator_username_label()}</span>
      <input
        name="username"
        type="text"
        autocomplete="username"
        bind:value={$form.username}
        class={field}
      />
      {#if $errors.username}<span class="text-xs text-destructive">{$errors.username}</span>{/if}
    </label>

    <label class="flex flex-col gap-1.5">
      <span class="text-sm font-medium text-foreground">{m.educator_password_label()}</span>
      <input
        name="password"
        type="password"
        autocomplete="new-password"
        bind:value={$form.password}
        class={field}
      />
      <span class="text-xs text-muted-foreground">
        {m.setup_educator_password_hint({ min: minLength })}
      </span>
      {#if $errors.password}<span class="text-xs text-destructive">{$errors.password}</span>{/if}
    </label>

    <label class="flex flex-col gap-1.5">
      <span class="text-sm font-medium text-foreground">{m.setup_confirm_password_label()}</span>
      <input
        name="confirmPassword"
        type="password"
        autocomplete="new-password"
        bind:value={$form.confirmPassword}
        class={field}
      />
      {#if $errors.confirmPassword}
        <span class="text-xs text-destructive">{$errors.confirmPassword}</span>
      {/if}
    </label>

    <button
      type="submit"
      disabled={$submitting}
      class="h-10 self-start rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90"
    >
      {m.setup_educator_submit()}
    </button>
  </form>
</section>
