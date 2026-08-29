<script lang="ts">
import AvailabilityControls from "$lib/components/educator/AvailabilityControls.svelte";
import ClassroomMeters from "$lib/components/educator/ClassroomMeters.svelte";
import type { PageProps } from "./$types";

/**
 * The classroom's own dashboard (PRD §8, §17).
 *
 * Availability first, because that is what an educator opens this page to
 * change; the meters below it answer "is anyone here, and are we near the cap"
 * without a single word anybody wrote (§16).
 */
let { data }: PageProps = $props();
</script>

<div class="flex max-w-4xl flex-col gap-8">
  <AvailabilityControls
    availability={data.overview.availability}
    timezone={data.overview.timezone}
  />

  <ClassroomMeters overview={data.overview} />
</div>
