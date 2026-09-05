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
    .split(/\r?\n[ \t]*(?:\r?\n[ \t]*)+/)
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
  const latest = thinkingParagraphs(text).at(-1) ?? "";
  return thinkingParagraphHeadline(latest, maxLength);
}

/** The component already has paragraphs; do not split the whole summary twice. */
export function thinkingParagraphHeadline(paragraph: string, maxLength = 80): string {
  const newline = paragraph.indexOf("\n");
  const line = newline === -1 ? paragraph : paragraph.slice(0, newline);

  const stripped = line
    .replace(/^\s*(?:[-*+>]\s+|#{1,6}\s+)/, "")
    .replace(
      /`([^`]+)`|(^|[\s([{])(\*\*|__|\*|_)([^\s*_](?:.*?[^\s*_])?)\3(?=$|[\s.,!?;:)\]}])/g,
      (_match, code: string | undefined, prefix: string, _marker, emphasized: string) =>
        code ?? prefix + emphasized,
    )
    .trim();

  if (stripped.length <= maxLength) return stripped;
  return `${stripped.slice(0, maxLength - 1).trimEnd()}…`;
}
