import { describe, expect, it } from "bun:test";
import { BASE_SYSTEM_PROMPT, buildSystemPrompt } from "./system-prompt";

/**
 * System-prompt layering (plan 1.5, PRD §10, §22).
 *
 * Later layers are empty until Phases 2.9 and 3.7; the layering contract is
 * fixed now so neither phase has to revisit it.
 */

describe("buildSystemPrompt", () => {
  it("is the base prompt alone when every optional layer is absent", () => {
    expect(buildSystemPrompt()).toBe(BASE_SYSTEM_PROMPT);
    expect(buildSystemPrompt({})).toBe(BASE_SYSTEM_PROMPT);
  });

  it("orders base, then classroom, then student, then the skill index", () => {
    const prompt = buildSystemPrompt({
      classroomInstructions: "Answer in Danish.",
      studentInstructions: "Explain before showing code.",
      skillIndex: [{ name: "essay-feedback", description: "Give feedback on an essay." }],
    });

    const positions = [
      prompt.indexOf(BASE_SYSTEM_PROMPT),
      prompt.indexOf("Answer in Danish."),
      prompt.indexOf("Explain before showing code."),
      prompt.indexOf("essay-feedback"),
    ];

    expect(positions.every((position) => position >= 0)).toBe(true);
    // The order is the contract: a later layer refines an earlier one (§10).
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it("omits a layer that is absent, empty or whitespace rather than emitting an empty heading", () => {
    for (const empty of [undefined, null, "", "   ", "\n\t"]) {
      expect(buildSystemPrompt({ classroomInstructions: empty })).toBe(BASE_SYSTEM_PROMPT);
      expect(buildSystemPrompt({ studentInstructions: empty })).toBe(BASE_SYSTEM_PROMPT);
    }
    expect(buildSystemPrompt({ skillIndex: [] })).toBe(BASE_SYSTEM_PROMPT);
  });

  it("includes a student layer even when the classroom layer is absent", () => {
    const prompt = buildSystemPrompt({ studentInstructions: "Use short sentences." });

    expect(prompt).toContain("Use short sentences.");
    expect(prompt.startsWith(BASE_SYSTEM_PROMPT)).toBe(true);
  });

  it("lists each skill as a name and one-line description, not a body", () => {
    const prompt = buildSystemPrompt({
      skillIndex: [
        { name: "essay-feedback", description: "Give feedback on an essay." },
        { name: "debug-help", description: "Help find a bug." },
      ],
    });

    expect(prompt).toContain("- essay-feedback: Give feedback on an essay.");
    expect(prompt).toContain("- debug-help: Help find a bug.");
  });

  it("skips a nameless skill entry", () => {
    expect(buildSystemPrompt({ skillIndex: [{ name: "  ", description: "orphan" }] })).toBe(
      BASE_SYSTEM_PROMPT,
    );
  });
});
