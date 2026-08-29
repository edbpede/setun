<script lang="ts">
import { enhance } from "$app/forms";
import SetunMark from "$lib/components/brand/SetunMark.svelte";
import * as m from "$lib/paraglide/messages";
import type { ActionData } from "./$types";

/**
 * The student login screen (PRD §7).
 *
 * One field, because the access code is the whole credential. Progressively
 * enhanced: the form posts and works without JavaScript.
 *
 * One message for every credential rejection, matching the server's single
 * failure branch — nothing here discloses whether a code exists (§7, §21). The
 * second message is for a refused address, which is a property of the network
 * and not of any code; a pupil told their code was wrong when the limiter had
 * simply run out goes looking for a typo that is not there.
 */
interface Props {
  form: ActionData;
}

let { form }: Props = $props();
</script>

<svelte:head><title>{m.login_title()} · {m.app_name()}</title></svelte:head>

<main class="mx-auto flex min-h-svh w-full max-w-sm flex-col justify-center gap-6 p-6">
  <div class="flex flex-col items-center gap-3 text-center">
    <SetunMark size={48} class="text-primary" />
    <h1 class="text-xl font-semibold text-foreground">{m.login_title()}</h1>
    <p class="text-sm text-muted-foreground">{m.login_intro()}</p>
  </div>

  <form method="POST" use:enhance class="flex flex-col gap-3">
    <label class="flex flex-col gap-1.5">
      <span class="text-sm font-medium text-foreground">{m.login_code_label()}</span>
      <input
        name="code"
        type="text"
        required
        autocomplete="off"
        autocapitalize="characters"
        spellcheck="false"
        placeholder={m.login_code_placeholder()}
        aria-invalid={form?.failed ? "true" : undefined}
        aria-describedby={form?.failed ? "login-error" : undefined}
        class="h-11 rounded-md border border-input bg-background px-3 text-center font-mono text-sm tracking-wide text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
      />
    </label>

    {#if form?.failed}
      <p id="login-error" class="text-sm text-destructive" role="alert">
        {form?.rateLimited ? m.login_rate_limited() : m.login_failed()}
      </p>
    {/if}

    <button
      type="submit"
      class="h-11 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90"
    >
      {m.login_submit()}
    </button>
  </form>

  <p class="text-center text-xs text-muted-foreground">{m.login_help()}</p>
</main>
