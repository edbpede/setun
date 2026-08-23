import type { AppDatabase } from "../db/client";
import { listActiveSkills } from "../db/queries/skills";
import type { Skill, SkillAuthoringPolicy } from "../db/schema";

/**
 * The skills registry (PRD §12).
 *
 * "Skill names and one-line descriptions are injected into the system prompt;
 * the full body is retrieved on demand through an internal load tool, so skills
 * cost almost nothing until used."
 *
 * Two surfaces, one resolution: the index that goes into the prompt, and the
 * loader that answers the tool. Both read the same list, so a skill can never
 * be advertised in the prompt and then refused by the loader, or the reverse.
 */

/** The name the model calls to read a skill's body. Internal, never an MCP tool (§12). */
export const LOAD_SKILL_TOOL = "load_skill";

export interface ResolvedSkills {
  readonly skills: readonly Skill[];
  /** Name to skill, for the loader. Names are what the model has to work with. */
  readonly byName: ReadonlyMap<string, Skill>;
}

/**
 * The skills active for one student.
 *
 * A classroom that has switched student authoring off drops the student's own
 * skills from the resolution entirely — §12 offers "disabled per classroom" as
 * a real setting, and a policy that only hid the authoring form would leave
 * yesterday's skills running.
 */
export function resolveSkills(
  db: AppDatabase,
  input: {
    classroomId: string;
    studentId: string;
    authoringPolicy: SkillAuthoringPolicy;
  },
): ResolvedSkills {
  const skills = listActiveSkills(db, {
    classroomId: input.classroomId,
    studentId: input.studentId,
    includeStudentAuthored: input.authoringPolicy !== "disabled",
  });

  return { skills, byName: new Map(skills.map((entry) => [entry.name, entry])) };
}

/**
 * The index entries appended last to the system prompt (§10, §12).
 *
 * Name and one line each — the prompt builder owns the wording, and this owns
 * which skills are in it, so the two cannot disagree about what is available.
 */
export function skillIndexEntries(
  resolved: ResolvedSkills,
): { name: string; description: string }[] {
  return resolved.skills.map((entry) => ({ name: entry.name, description: entry.description }));
}

/** What the load tool returns to the model. */
export type SkillLoadResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly text: string };

/**
 * Load one skill's body, for a student who is allowed it.
 *
 * The resolution is passed in rather than re-queried, which is what makes the
 * refusal below meaningful: a skill that is disabled, unapproved, or belongs to
 * another student was never in the map, so the loader refuses it by construction
 * rather than by remembering to check (§12, §21, §22).
 */
export function loadSkill(resolved: ResolvedSkills, name: string): SkillLoadResult {
  const entry = resolved.byName.get(name);
  if (!entry) {
    return {
      ok: false,
      text: `No skill named '${name}' is available. Available skills: ${
        resolved.skills.map((skill) => skill.name).join(", ") || "none"
      }.`,
    };
  }

  const resources = entry.resources.map(
    (resource) => `\n\n## ${resource.name}\n\n${resource.text}`,
  );

  return { ok: true, text: `# ${entry.name}\n\n${entry.body}${resources.join("")}` };
}

/** The JSON Schema the loader advertises to the model. */
export function loadSkillSchema(resolved: ResolvedSkills): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "The exact name of the skill to read.",
        ...(resolved.skills.length > 0 ? { enum: resolved.skills.map((entry) => entry.name) } : {}),
      },
    },
    required: ["name"],
    additionalProperties: false,
  };
}
