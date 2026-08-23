/**
 * System-prompt assembly (PRD §10).
 *
 * "The system prompt is layered: Setun's fixed base prompt, then optional
 * classroom instructions, then optional per-student instructions… The skill
 * index is appended last."
 *
 * The order is the contract — a later layer is read as refining an earlier one,
 * which is what makes per-student scaffolding able to soften a classroom rule.
 * Students never author any layer; student-driven behaviour flows through skills
 * (§10, §12).
 *
 * Classroom and per-student instructions arrive in Phase 2.9 and the skill index
 * in Phase 3.7; the layering and its coverage exist now so neither phase has to
 * revisit this file.
 */

/**
 * Setun's fixed base layer.
 *
 * Deliberately short: it establishes the setting and leaves pedagogy to the
 * educator's layers, which are the steering instrument (§10).
 */
export const BASE_SYSTEM_PROMPT = [
  "You are the AI assistant inside Setun, a learning environment used in school lessons.",
  "You are talking with a pupil. Be accurate, be clear, and prefer a short explanation over a long one.",
  "Explain your reasoning in plain language. When you show code, explain what it does before or after the block.",
  "If you do not know something, say so plainly rather than inventing it.",
].join("\n");

export interface SystemPromptLayers {
  /** Educator-authored, applies to the whole classroom (§10). */
  readonly classroomInstructions?: string | null;
  /** Educator-authored, applies to one student (§10). */
  readonly studentInstructions?: string | null;
  /** Name and one-line description per active skill; the body loads on demand (§12). */
  readonly skillIndex?: readonly { name: string; description: string }[];
}

const SECTION_SEPARATOR = "\n\n";

function section(heading: string, body: string): string {
  return `${heading}\n${body}`;
}

/**
 * Compose the layers into the single system message the adapter sends.
 *
 * Empty, whitespace-only and absent layers are all omitted rather than emitted
 * as empty headings: an empty section reads to a model as an instruction with no
 * content, and at M1 every optional layer is empty.
 */
export function buildSystemPrompt(layers: SystemPromptLayers = {}): string {
  const parts: string[] = [BASE_SYSTEM_PROMPT];

  const classroom = layers.classroomInstructions?.trim();
  if (classroom) {
    parts.push(section("Instructions for this class:", classroom));
  }

  const student = layers.studentInstructions?.trim();
  if (student) {
    parts.push(section("Instructions for this pupil:", student));
  }

  const skills = (layers.skillIndex ?? []).filter((skill) => skill.name.trim().length > 0);
  if (skills.length > 0) {
    parts.push(
      section(
        "Skills available to you. Load one by name when it is relevant:",
        skills.map((skill) => `- ${skill.name}: ${skill.description}`).join("\n"),
      ),
    );
  }

  return parts.join(SECTION_SEPARATOR);
}
