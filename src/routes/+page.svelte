<script lang="ts">
import { resolve } from "$app/paths";
import * as m from "$lib/paraglide/messages";
</script>

<main class="mx-auto flex max-w-2xl flex-col gap-4 p-8">
  <h1 class="text-2xl font-semibold text-foreground">{m.app_name()}</h1>
  <p class="text-muted-foreground">{m.home_tagline()}</p>
  <a class="text-primary underline underline-offset-4" href={resolve("/stack-check")}>
    {m.home_stack_check_link()}
  </a>
</main>
