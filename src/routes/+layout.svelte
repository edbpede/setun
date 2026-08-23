<script lang="ts">
// The single UnoCSS entry point. presetWind4 ships its own preflight, so the
// Wind3 reset is deliberately not imported on top of it.
import "virtual:uno.css";
import "../app.css";

let { children } = $props();
</script>

{@render children()}
