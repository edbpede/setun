import { LOAD_SKILL_TOOL } from "../skills/registry";

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
 * The skill index is the last layer because §10 says so, and because the
 * loader below it must describe tools the earlier layers may have talked about.
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

/**
 * What an artifact is, told to the model (§13).
 *
 * The base prompt never mentioned artifacts, and the model was never told that a
 * fenced `html` block becomes a live document, that the block *replaces* the
 * file, or that anything it leaves out is gone. So "add a quiz about me" was
 * answered with the quiz alone — a correct answer to the question asked, and the
 * page disappeared. Everything in here exists because its absence produced a
 * specific failure a pupil could see.
 *
 * Addressed to the model and therefore in English and not a Paraglide message,
 * exactly like the `artifact-edit` marker: the pupil's own language is a matter
 * for the prose, which the last paragraph asks for in their language.
 *
 * Part of the fixed prefix so it stays cacheable across turns and classrooms.
 */
export const ARTIFACT_INSTRUCTIONS = [
  "Building things with the pupil.",
  "A fenced code block tagged html, svg, jsx, tsx or svelte is not shown as code. Setun turns it",
  "into an artifact: a live document the pupil can run, edit and keep, with every version saved.",
  "Any other tag (js, css, python, json…) stays an ordinary code block.",
  "Give every artifact an id on the fence, and a title the first time you write it:",
  '```html id=home-page title="Min hjemmeside"',
  "…the complete file…",
  "```",
  "The id is a short lowercase slug (letters, digits, - and _). Reuse the id to change that",
  "artifact; use a new id to make a separate thing. When you change an artifact, write the",
  'COMPLETE file again under the same id — never a fragment, a diff or "…rest unchanged": the',
  "block replaces the whole file, so anything you leave out is gone. One artifact per message",
  "unless the pupil asks for more; explain outside the block, briefly, in the pupil's language.",
  "The artifact runs alone in a sandboxed frame about 640 px tall: one file, no network, no CDN,",
  "no external scripts, fonts or images (use SVG, CSS, canvas or data: URLs). alert/confirm/prompt",
  "do nothing — show messages in the page. localStorage and sessionStorage work but hold at most",
  "64 KB and last only while the pupil has the panel open. indexedDB and cookies are unavailable.",
  "html may be a fragment or a full document; svg is the bare <svg>; jsx and tsx must",
  "default-export one component; svelte is an ordinary component file — markup with a <script>",
  "and a <style> if it needs them, and never an export default, which Svelte refuses to compile.",
  "Importable: react, react-dom/client, react/jsx-runtime, svelte — nothing else.",
  "Tailwind-style utility classes work (UnoCSS).",
  "For games and animation: draw on <canvas> with requestAnimationFrame and clamp the frame delta",
  "(the loop pauses while the pupil looks at the code); size from window.innerWidth/innerHeight",
  "and handle resize; listen for keys on window and preventDefault arrows/space; also support",
  "touch/pointer with targets ≥ 44 px. The frame gets keyboard focus after it renders and when the",
  "pupil taps it. Start audio only inside a click or key handler.",
  "Before the pupil's message you may find a note listing this conversation's artifacts by id,",
  "language, revision, author and last run result. If the last run failed, fix that error in your",
  "next complete version of the same id.",
].join("\n");

/**
 * The whole of what Setun itself says, before any educator layer.
 *
 * Ordered platform fact first, pedagogy after: the artifact rules describe what
 * the surface *is*, and a classroom instruction that softens or narrows them
 * should be read as refining a fact already stated (§10).
 */
export const FIXED_SYSTEM_PROMPT = `${BASE_SYSTEM_PROMPT}\n\n${ARTIFACT_INSTRUCTIONS}`;

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
  const parts: string[] = [FIXED_SYSTEM_PROMPT];

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
        [
          "Skills available to you. The lines below are labels, not the instructions themselves —",
          `call the ${LOAD_SKILL_TOOL} tool with a skill's name to read it in full before acting on it:`,
        ].join("\n"),
        skills.map((skill) => `- ${skill.name}: ${skill.description}`).join("\n"),
      ),
    );
  }

  return parts.join(SECTION_SEPARATOR);
}
