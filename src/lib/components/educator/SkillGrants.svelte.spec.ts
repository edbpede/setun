import { describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-svelte";
import * as m from "$lib/paraglide/messages";
import SkillGrants from "./SkillGrants.svelte";

const SKILL = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Source review",
  description: "Review a source",
  enabled: true,
  classWide: false,
  studentIds: [],
};

describe("SkillGrants", () => {
  it.each([
    {
      classWide: true,
      label: m.educator_skill_grant_remove(),
      absentLabel: m.educator_skill_grant_class(),
      action: "?/revokeSkill",
    },
    {
      classWide: false,
      label: m.educator_skill_grant_class(),
      absentLabel: m.educator_skill_grant_remove(),
      action: "?/grantSkill",
    },
  ])(
    "maps class-wide state to the $action action",
    async ({ classWide, label, absentLabel, action }) => {
      render(SkillGrants, { skills: [{ ...SKILL, classWide }], students: [] });

      const submit = page.getByRole("button", { name: label });
      await expect.element(submit).toBeInTheDocument();
      await expect.element(submit).toHaveAttribute("type", "submit");
      expect(submit.element().closest("form")?.getAttribute("action")).toBe(action);
      await expect.element(page.getByRole("button", { name: absentLabel })).not.toBeInTheDocument();
    },
  );
});
