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
  /** Index of the closing fence line, so a whole block can be replaced by line. */
  readonly endLine: number;
  /**
   * `key=value` pairs written after the language, lowercased keys, in either
   * quote style or bare (§13). CommonMark says nothing about the info string
   * past the language, and neither `marked` nor `hasOpenFence` reads it, so this
   * is Setun's own use of space the renderer already ignores.
   *
   * First match per key wins: a model that writes `id=a id=b` meant the first.
   */
  readonly attributes: Readonly<Record<string, string>>;
}

const OPENING = /^ {0,3}(`{3,}|~{3,})[ \t]*(.*)$/;

const ATTRIBUTE = /([A-Za-z_][\w-]*)=(?:"([^"]*)"|'([^']*)'|(\S+))/g;

/** The `key=value` pairs of an info string, past its first word. */
function attributesOf(info: string): Record<string, string> {
  // Null-prototype: `"constructor" in {}` is true, so a plain object would read
  // an inherited name as an attribute already seen and drop the real one.
  const attributes: Record<string, string> = Object.create(null);

  // A fresh matcher each call: a module-level `g` regex carries `lastIndex`.
  for (const match of info.matchAll(new RegExp(ATTRIBUTE.source, "g"))) {
    const key = match[1].toLowerCase();
    if (key in attributes) continue;
    attributes[key] = match[2] ?? match[3] ?? match[4] ?? "";
  }

  return attributes;
}

/**
 * The fence a message ends inside, when it ends inside one.
 *
 * A block still arriving is not an artifact and never becomes one here — it has
 * no source to render and no closing line to bound it. But a streaming
 * transcript has to know that a fence is *open*, or the pupil watches
 * `<!doctype html>` scroll past as prose (§20).
 */
export interface OpenFence {
  readonly language: string | null;
  readonly attributes: Readonly<Record<string, string>>;
  /** Index of the opening fence line; everything from here on is inside it. */
  readonly line: number;
}

export interface ScannedFences {
  readonly blocks: FencedBlock[];
  readonly open: OpenFence | null;
}

/**
 * One pass over the markdown: every closed block, and the trailing open fence.
 *
 * `fencedBlocks` is this scan with the open fence discarded, which is what every
 * caller that works on settled text wants.
 */
export function scanFences(markdown: string): ScannedFences {
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

    const [first, ...rest] = info.split(/\s+/);
    const closing = findClosing(lines, index + 1, fence);
    // An unclosed fence is a block still arriving; it is not an artifact yet
    // (§20). Nothing after it can open another, so the scan ends here.
    if (closing === -1) {
      return {
        blocks,
        open: {
          language: first?.toLowerCase() || null,
          attributes: attributesOf(rest.join(" ")),
          line: index,
        },
      };
    }

    blocks.push({
      language: first?.toLowerCase() || null,
      source: lines.slice(index + 1, closing).join("\n"),
      line: index,
      endLine: closing,
      attributes: attributesOf(rest.join(" ")),
    });

    index = closing;
  }

  return { blocks, open: null };
}

/** Every closed fenced block, in the order it appears. An unclosed fence is skipped. */
export function fencedBlocks(markdown: string): FencedBlock[] {
  return scanFences(markdown).blocks;
}

/**
 * A fence long enough to hold this source (§13).
 *
 * A source that itself contains a line of three backticks — a page explaining
 * markdown, a component with a template literal — closes a three-backtick fence
 * early, and everything after that point reaches the model as prose. CommonMark
 * answers this with a longer fence, and `fencedBlocks` already honours one, so
 * what the model reads is unchanged for every source that did not need it.
 *
 * Leading backticks only: those are the ones that can close a fence.
 */
export function fenceFor(source: string): string {
  let longest = 0;

  for (const line of source.split("\n")) {
    const run = /^`+/.exec(line);
    if (run) longest = Math.max(longest, run[0].length);
  }

  return "`".repeat(Math.max(3, longest + 1));
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
