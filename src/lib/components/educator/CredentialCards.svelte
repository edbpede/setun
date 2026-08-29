<script lang="ts">
import type { CredentialCard } from "$lib/credentials";
import * as m from "$lib/paraglide/messages";
import type { Locale } from "$lib/paraglide/runtime";

/**
 * Printable credential cards (PRD §7, §17).
 *
 * "The code is shown at provisioning and rotation only" — so these cards exist
 * in exactly one response, are never fetched from anywhere, and are gone on the
 * next navigation. There is no route that could show them again, because there
 * is nothing stored that could answer it.
 *
 * The print stylesheet takes the panel away and leaves the cards: an educator
 * prints the sheet, cuts it up, and hands out the pieces.
 */

interface Props {
  cards: CredentialCard[];
  classroomName: string;
  /**
   * The classroom's interface language (§17).
   *
   * The card is cut out and handed to a pupil, so what is printed on it is
   * addressed to them and belongs in the language of the room — not in whichever
   * language the educator happens to be running the panel in. The chrome around
   * it is the educator's and stays in theirs.
   */
  locale: Locale;
}

let { cards, classroomName, locale }: Props = $props();

// Paraglide takes an explicit locale per call; the ambient one is the reader's.
const cardLocale = $derived({ locale });
</script>

{#if cards.length > 0}
  <section class="print-cards flex flex-col gap-3 rounded-md border border-primary p-4">
    <div class="no-print flex flex-wrap items-center justify-between gap-2">
      <h2 class="text-sm font-medium text-foreground">{m.educator_cards_title()}</h2>
      <button
        type="button"
        onclick={() => window.print()}
        class="h-8 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90"
      >
        {m.educator_print()}
      </button>
    </div>

    <p class="no-print text-xs text-destructive">{m.educator_cards_once()}</p>

    <ul class="grid gap-3 sm:grid-cols-2">
      {#each cards as card (card.label)}
        <li class="flex flex-col gap-1.5 rounded-md border border-border bg-background p-3">
          <span class="text-[0.6875rem] uppercase tracking-[0.12em] text-muted-foreground">
            {classroomName}
          </span>
          <span class="text-sm font-semibold text-foreground">{card.label}</span>
          <code class="select-all break-all font-mono text-sm text-foreground">{card.code}</code>
          <span class="text-[0.6875rem] text-muted-foreground">
            {m.educator_card_help({}, cardLocale)}
          </span>
        </li>
      {/each}
    </ul>
  </section>
{/if}

<style>
@media print {
  :global(body *) {
    visibility: hidden;
  }

  .print-cards,
  .print-cards * {
    visibility: visible;
  }

  .print-cards {
    position: absolute;
    inset-block-start: 0;
    inset-inline-start: 0;
    inline-size: 100%;
    border: none;
  }

  .no-print {
    display: none;
  }
}
</style>
