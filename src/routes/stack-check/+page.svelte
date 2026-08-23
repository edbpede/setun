<script lang="ts">
import StackCheckPanel from "$lib/components/stack-check/StackCheckPanel.svelte";
import * as m from "$lib/paraglide/messages";
</script>

<main class="mx-auto flex max-w-3xl flex-col gap-6 p-8">
  <header class="flex flex-col gap-2">
    <h1 class="text-2xl font-semibold text-foreground">{m.stack_check_title()}</h1>
    <p class="text-muted-foreground">{m.stack_check_intro()}</p>
  </header>

  <StackCheckPanel />
</main>
