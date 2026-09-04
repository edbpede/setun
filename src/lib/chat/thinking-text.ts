/**
 * Reading a reasoning summary as text (PRD §20).
 *
 * Providers write summaries as short paragraphs, often with a bold headline per
 * step. Nothing here parses markdown: the model wrote it, and a model's output
 * is untrusted — the block renders text nodes and nothing else (§21). So the
 * only structure taken from it is the paragraph split, and the headline is a
 * plain string the summary line can truncate.
 */

/** Split a summary into paragraphs, dropping the blank runs between them. */
export function thinkingParagraphs(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);
}

/**
 * The latest headline, for the one line shown while the block is collapsed.
 *
 * The last paragraph's first line, with any leading markdown emphasis or list
 * marker stripped — those are decoration a provider added, and rendered as
 * literal asterisks they read as noise.
 */
export function thinkingHeadline(text: string, maxLength = 80): string {
  const paragraphs = thinkingParagraphs(text);
  const latest = paragraphs.at(-1) ?? "";
  const line = latest.split("\n")[0] ?? "";

  const stripped = line
    .replace(/^[-*+>\s]+/, "")
    .replace(/\*\*|__|[*_`#]/g, "")
    .trim();

  if (stripped.length <= maxLength) return stripped;
  return `${stripped.slice(0, maxLength - 1).trimEnd()}…`;
}
