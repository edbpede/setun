/**
 * Fenced code blocks, scanned out of model prose (PRD §13).
 *
 * Detection is the renderer's job and needs the same answer on the server —
 * which persists the artifact — and in the browser, which renders it. So the
 * scan lives here once rather than in each of them.
 *
 * The rules are CommonMark's, narrowed to what a fence needs: an opening line of
 * at least three backticks or tildes indented no more than three spaces, an
 * optional info string whose first word is the language, and a closing line of
 * the same character at least as long and carrying no info string. Backtick
 * fences cannot contain backticks in their info string; tilde fences may.
 */

export interface FencedBlock {
  /** The first word of the info string, lowercased; null when there was none. */
  readonly language: string | null;
  readonly source: string;
  /** Index of the opening fence line, which orders blocks within a message. */
  readonly line: number;
}

const OPENING = /^ {0,3}(`{3,}|~{3,})[ \t]*(.*)$/;

/** Every closed fenced block, in the order it appears. An unclosed fence is skipped. */
export function fencedBlocks(markdown: string): FencedBlock[] {
  const lines = markdown.split("\n");
  const blocks: FencedBlock[] = [];

  for (let index = 0; index < lines.length; index++) {
    const opening = OPENING.exec(lines[index]);
    if (!opening) continue;

    const fence = opening[1];
    const info = opening[2].trim();

    // A backtick fence's info string may not contain a backtick — that is what
    // keeps inline code on the same line from opening a block.
    if (fence.startsWith("`") && info.includes("`")) continue;

    const closing = findClosing(lines, index + 1, fence);
    // An unclosed fence is a block still arriving; it is not an artifact yet (§20).
    if (closing === -1) break;

    blocks.push({
      language: info.split(/\s+/)[0]?.toLowerCase() || null,
      source: lines.slice(index + 1, closing).join("\n"),
      line: index,
    });

    index = closing;
  }

  return blocks;
}

function findClosing(lines: readonly string[], from: number, fence: string): number {
  const marker = fence[0];

  for (let index = from; index < lines.length; index++) {
    const candidate = OPENING.exec(lines[index]);
    if (!candidate) continue;

    // Same character, at least as long, and nothing after it.
    if (candidate[1][0] === marker && candidate[1].length >= fence.length && !candidate[2].trim()) {
      return index;
    }
  }

  return -1;
}
