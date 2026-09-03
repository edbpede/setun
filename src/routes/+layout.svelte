<script lang="ts">
// The single UnoCSS entry point. presetWind4 ships its own preflight, so the
// Wind3 reset is deliberately not imported on top of it.
import "virtual:uno.css";
import "../app.css";
import { provideTheme } from "$lib/state/theme.svelte";

let { children } = $props();

/**
 * Light or dark, for every route under this layout.
 *
 * Provided here rather than imported as a module singleton: a singleton in a
 * `.svelte.ts` module is shared across every SSR request on the server. The
 * inline script in `src/app.html` has already painted the right theme; this
 * takes over from it and follows the device while the tab is open.
 */
const theme = provideTheme();

$effect(() => theme.start());
$effect(() => theme.apply());
</script>

{@render children()}
