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
  it("names the inverse action after a whole-class grant", async () => {
    render(SkillGrants, { skills: [{ ...SKILL, classWide: true }], students: [] });

    const remove = page.getByRole("button", { name: m.educator_skill_grant_remove() });
    await expect.element(remove).toBeInTheDocument();
    await expect.element(remove).toHaveAttribute("type", "submit");
    await expect
      .element(page.getByRole("button", { name: m.educator_skill_grant_class() }))
      .not.toBeInTheDocument();
  });
});
