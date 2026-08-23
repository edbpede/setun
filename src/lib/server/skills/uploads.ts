/**
 * Reading an uploaded skill file (PRD §12, §21).
 *
 * "Library skills are authored in the panel, uploaded as files, or imported from
 * the skills.sh registry… Imported and uploaded skill text is untrusted content:
 * it arrives disabled and takes effect only when the educator enables it."
 *
 * Untrusted is the whole design of this module: the text is parsed, never
 * evaluated, and nothing in a file can set anything but the three fields a skill
 * has. There is no field that could switch a skill on, because the caller does
 * not pass one — enablement is the educator's action, not the file's.
 */

export interface ParsedSkillFile {
  readonly name: string;
  readonly description: string;
  readonly body: string;
}

export type SkillFileParse =
  | { readonly ok: true; readonly skill: ParsedSkillFile }
  | { readonly ok: false };

/** Bounds matching the panel form's, so an upload cannot exceed what is editable. */
const MAX_NAME = 60;
const MAX_DESCRIPTION = 200;
const MAX_BODY = 64_000;

/**
 * Parse a Markdown or plain-text skill file.
 *
 * Front matter first, because that is the shape the registry and the ecosystem
 * use; a file without it falls back to its first heading and first paragraph, so
 * an educator can upload an ordinary note without learning a format.
 */
export function parseSkillFile(filename: string, text: string): SkillFileParse {
  if (text.trim().length === 0) return { ok: false };

  const front = readFrontMatter(text);
  const body = (front ? front.rest : text).trim().slice(0, MAX_BODY);
  if (body.length === 0) return { ok: false };

  const name = clean(front?.fields.name ?? headingOf(body) ?? basename(filename), MAX_NAME);
  const description = clean(
    front?.fields.description ?? firstParagraph(body) ?? name,
    MAX_DESCRIPTION,
  );

  if (!name) return { ok: false };

  return { ok: true, skill: { name, description, body } };
}

/**
 * Read a leading `---` block as flat `key: value` pairs.
 *
 * Deliberately not a YAML parser: a skill's front matter carries a name and a
 * description, and a real parser would accept anchors, tags and nesting from a
 * file the PRD calls untrusted.
 */
function readFrontMatter(text: string): { fields: Record<string, string>; rest: string } | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return null;

  const fields: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator === -1) continue;

    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line
      .slice(separator + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
    if (key && value) fields[key] = value;
  }

  return { fields, rest: text.slice(match[0].length) };
}

function headingOf(body: string): string | null {
  const heading = /^#{1,6}\s+(.+)$/m.exec(body);
  return heading ? heading[1].trim() : null;
}

function firstParagraph(body: string): string | null {
  for (const block of body.split(/\r?\n\s*\r?\n/)) {
    const line = block.trim().replace(/^#{1,6}\s+/, "");
    if (line.length > 0) return line.replace(/\s+/g, " ");
  }
  return null;
}

function basename(filename: string): string {
  return (filename.split(/[\\/]/).pop() ?? "").replace(/\.[a-z0-9]+$/i, "");
}

/**
 * Reduce a field to what a skill name or description may contain.
 *
 * Control characters and newlines are collapsed rather than escaped: these two
 * fields go into the system prompt, where a newline is a way to make one line
 * look like several instructions (§12, §21).
 */
function clean(value: string, max: number): string {
  // Character by character rather than by regular expression: a control-character
  // range inside a pattern is exactly what the linter refuses, and the intent is
  // clearer written as the predicate it is.
  const printable = Array.from(value, (character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f ? " " : character;
  }).join("");

  return printable.replace(/\s+/g, " ").trim().slice(0, max);
}
