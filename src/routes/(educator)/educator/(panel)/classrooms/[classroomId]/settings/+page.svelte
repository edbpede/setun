<script lang="ts">
import AllowlistEditor from "$lib/components/educator/AllowlistEditor.svelte";
import BudgetForm from "$lib/components/educator/BudgetForm.svelte";
import PolicyForm from "$lib/components/educator/PolicyForm.svelte";
import ScheduleEditor from "$lib/components/educator/ScheduleEditor.svelte";
import SkillGrants from "$lib/components/educator/SkillGrants.svelte";
import StudentSkillOversight from "$lib/components/educator/StudentSkillOversight.svelte";
import TemporaryWindowEditor from "$lib/components/educator/TemporaryWindowEditor.svelte";
import ToolAllowlist from "$lib/components/educator/ToolAllowlist.svelte";
import ToolPolicyForm from "$lib/components/educator/ToolPolicyForm.svelte";
import type { PageProps } from "./$types";

/**
 * One classroom's configuration (PRD §8, §17).
 *
 * The settings an educator touches once a term, in the order §17 lists them:
 * when the room is open, what it may use, what it may spend, and how it speaks.
 */
let { data, form }: PageProps = $props();

const forceLoggedOut = $derived(
  form && "forceLoggedOut" in form ? (form.forceLoggedOut as number) : null,
);
</script>

<div class="flex max-w-4xl flex-col gap-8">
  <ScheduleEditor data={data.scheduleForm} />

  <TemporaryWindowEditor data={data.temporaryForm} />

  <AllowlistEditor aliases={data.aliases} />

  <BudgetForm data={data.budgetsForm} activePreset={data.activePreset} />

  <PolicyForm data={data.policyForm} {forceLoggedOut} />

  <ToolPolicyForm data={data.toolPolicyForm} />

  <ToolAllowlist servers={data.toolServers} />

  <SkillGrants skills={data.skills} students={data.students} />

  <StudentSkillOversight skills={data.studentSkills} />
</div>
