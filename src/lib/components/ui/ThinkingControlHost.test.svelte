<script lang="ts">
import { provideThinking } from "$lib/state/thinking.svelte";
import ThinkingControl from "./ThinkingControl.svelte";

/**
 * The container the root layout provides, for a test that renders the control
 * on its own.
 *
 * `.test.svelte` rather than `.svelte`: it is a fixture, and the suffix keeps it
 * out of the component list a reader scans for real components.
 */
const thinking = provideThinking();

$effect(() => thinking.start());
</script>

<ThinkingControl />
