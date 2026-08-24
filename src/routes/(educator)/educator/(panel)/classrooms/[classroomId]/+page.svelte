<script lang="ts">
import AllowlistEditor from "$lib/components/educator/AllowlistEditor.svelte";
import AvailabilityControls from "$lib/components/educator/AvailabilityControls.svelte";
import BudgetForm from "$lib/components/educator/BudgetForm.svelte";
import PolicyForm from "$lib/components/educator/PolicyForm.svelte";
import RosterInstructions from "$lib/components/educator/RosterInstructions.svelte";
import ScheduleEditor from "$lib/components/educator/ScheduleEditor.svelte";
import SkillGrants from "$lib/components/educator/SkillGrants.svelte";
import StudentSkillOversight from "$lib/components/educator/StudentSkillOversight.svelte";
import TemporaryWindowEditor from "$lib/components/educator/TemporaryWindowEditor.svelte";
import ToolAllowlist from "$lib/components/educator/ToolAllowlist.svelte";
import ToolPolicyForm from "$lib/components/educator/ToolPolicyForm.svelte";
import * as m from "$lib/paraglide/messages";
import type { PageProps } from "./$types";

/**
 * One classroom, configured (PRD §8, §17).
 *
 * Availability first, because that is what an educator opens this page to change
 * between lessons; everything else is settings they touch once a term.
 */
let { data, form }: PageProps = $props();

const forceLoggedOut = $derived(
  form && "forceLoggedOut" in form ? (form.forceLoggedOut as number) : null,
);
</script>

<svelte:head><title>{data.classroom.name} · {m.educator_panel_title()}</title></svelte:head>

<div class="flex max-w-4xl flex-col gap-8">
  <header class="flex flex-col gap-1">
    <h1 class="text-base font-semibold text-foreground">{data.classroom.name}</h1>
    <p class="text-xs text-muted-foreground">{data.classroom.timezone}</p>
  </header>

  <AvailabilityControls
    availability={data.availability}
    state={data.classroom.state}
    timezone={data.classroom.timezone}
  />

  <ScheduleEditor data={data.scheduleForm} />

  <TemporaryWindowEditor data={data.temporaryForm} />

  <AllowlistEditor aliases={data.aliases} />

  <BudgetForm data={data.budgetsForm} />

  <PolicyForm data={data.policyForm} {forceLoggedOut} />

  <ToolPolicyForm data={data.toolPolicyForm} />

  <ToolAllowlist servers={data.toolServers} />

  <SkillGrants skills={data.skills} students={data.students} />

  <StudentSkillOversight skills={data.studentSkills} />

  <RosterInstructions students={data.students} />
</div>
