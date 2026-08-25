<script lang="ts">
import { enhance } from "$app/forms";
import CredentialCards from "$lib/components/educator/CredentialCards.svelte";
import RosterTable from "$lib/components/educator/RosterTable.svelte";
import type { CredentialCard } from "$lib/credentials";
import * as m from "$lib/paraglide/messages";
import type { PageProps } from "./$types";

/**
 * The roster and provisioning (PRD §7, §17).
 *
 * Cards first when there are cards: they exist only in this response, so the
 * educator must not have to scroll to find them before navigating away (§7).
 */
let { data, form }: PageProps = $props();

const cards = $derived(
  form && "cards" in form ? ((form.cards ?? []) as CredentialCard[]) : ([] as CredentialCard[]),
);
const confirmMismatch = $derived(
  form && "confirmMismatch" in form ? ((form.confirmMismatch as string | null) ?? null) : null,
);
</script>

<div class="flex max-w-4xl flex-col gap-8">
  <CredentialCards {cards} classroomName={data.classroom.name} />

  <section class="flex flex-col gap-3">
    <h2 class="text-sm font-medium text-foreground">{m.educator_provision_title()}</h2>
    <p class="text-xs text-muted-foreground">{m.educator_provision_help()}</p>

    <form method="POST" action="?/provision" use:enhance class="flex flex-wrap items-end gap-2">
      <label class="flex flex-col gap-1">
        <span class="text-xs text-muted-foreground">{m.educator_provision_count_label()}</span>
        <input
          type="number"
          name="count"
          value="1"
          min="1"
          max="40"
          class="h-9 w-24 rounded-md border border-input bg-background px-2 text-sm text-foreground"
        />
      </label>
      <button
        type="submit"
        class="h-9 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90"
      >
        {m.educator_provision_submit()}
      </button>
    </form>
  </section>

  <RosterTable students={data.students} {confirmMismatch} />

  <p class="text-xs">
    <a
      href="?removed={data.includeRemoved ? '0' : '1'}"
      class="text-muted-foreground underline underline-offset-2 hover:text-foreground"
    >
      {data.includeRemoved ? m.educator_hide_removed() : m.educator_show_removed()}
    </a>
  </p>
</div>
