import { fencedBlocks } from "./fences";
import { normaliseArtifactKey } from "./identity";
import { kindOf, normaliseProjectPath, type ProjectFileKind } from "./project";
import { type ArtifactLanguage, isArtifactLanguage } from "./types";

/**
 * Which fenced blocks are artifacts (PRD §13).
 *
 * "No tool call, no model-side capability, no special protocol — this works with
 * any model the gateway offers." So the only signal is the fence tag, and the
 * recognised set is closed: `html` and `svg` render statically, `jsx`, `tsx` and
 * `svelte` compile, and everything else — "including bare `js`, `ts`, and `css`"
 * — stays an ordinary highlighted code block, because a fragment without markup
 * has nothing to render.
 *
 * A project loosens exactly one part of that. An artifact is a set of files now,
 * and its data, its types and its stylesheet are `ts`, `json` and `css` — tags
 * that must keep meaning "ordinary code block" everywhere else. So they become
 * artifact files only when the block carries *both* an `id=` naming the artifact
 * and a `path=` saying which file it is. A pupil's snippet of example CSS has
 * neither and is still a code block.
 */

export interface DetectedArtifact {
  /**
   * The artifact language this block runs as, or null when it is a file that is
   * only ever imported — a `ts` module, a stylesheet, a data file.
   */
  readonly language: ArtifactLanguage | null;
  /** The fence tag, whether or not it is runnable. */
  readonly kind: ProjectFileKind;
  readonly source: string;
  /** Position of the opening fence, so blocks are recorded in the order written. */
  readonly line: number;
  /** Position of the closing fence, so a whole block can be replaced by line. */
  readonly endLine: number;
  /**
   * The `id=` the model wrote, normalised; null when it wrote none or wrote
   * something that is not a slug. This is what continuity resolves on (§13).
   */
  readonly key: string | null;
  /** The `title=` the model wrote; null when it wrote none. */
  readonly title: string | null;
  /**
   * The `path=` the model wrote, normalised; null when it wrote none or wrote
   * one that is not a project path.
   *
   * Only honoured alongside an `id=`: a path without an artifact to belong to
   * names nothing, and guessing which artifact it meant is how a pupil's file
   * lands in somebody else's project.
   */
  readonly path: string | null;
  /** The `delete` flag: this file is removed from the project rather than written. */
  readonly deleted: boolean;
  /** The `entry` flag: this file is what runs, whatever the convention says. */
  readonly entry: boolean;
}

/**
 * Resolve a fence tag to an artifact language, or null to leave it a code block.
 *
 * Deliberately not alias-tolerant. `js` is not `jsx` and `htm` is not `html`:
 * a tag Setun does not recognise renders as code, which is the safe outcome,
 * whereas guessing renders somebody's plain snippet in an iframe.
 */
export function artifactLanguage(tag: string | null | undefined): ArtifactLanguage | null {
  if (!tag) return null;

  const normalised = tag.trim().toLowerCase();
  return isArtifactLanguage(normalised) ? normalised : null;
}

/** Every artifact block in a piece of model prose, in the order it was written. */
export function detectArtifacts(markdown: string): DetectedArtifact[] {
  const found: DetectedArtifact[] = [];

  for (const block of fencedBlocks(markdown)) {
    const kind = kindOf(`x.${(block.language ?? "").trim().toLowerCase()}`);
    if (!kind) continue;

    const language = artifactLanguage(block.language);
    const key = normaliseArtifactKey(block.attributes.id);
    // A path is only meaningful against an artifact, so it is read only where
    // one is named. An invalid path is treated as absent, never guessed at.
    const path = key ? normaliseProjectPath(block.attributes.path) : null;
    const deleted = "delete" in block.attributes;

    // A tag that is not runnable is a project file, and a project file needs
    // both halves of its address before it belongs to anything.
    if (!language && !(key && path)) continue;

    // An empty block is a fence the model opened and closed with nothing in it —
    // except for a deletion, which is exactly the block that has no body.
    if ((deleted && !(key && path)) || (!deleted && !block.source.trim())) continue;

    found.push({
      language,
      kind,
      source: block.source,
      line: block.line,
      endLine: block.endLine,
      key,
      title: block.attributes.title?.trim() || null,
      path,
      deleted,
      entry: "entry" in block.attributes,
    });
  }

  return found;
}

/**
 * One write of one artifact: every fence the model wrote under that id (§13).
 *
 * A model writing a project emits several fences in a row — the entry, a data
 * module, a stylesheet — all under the same `id=`. Those are one revision of one
 * thing, not three things, and this is where that is decided.
 *
 * Grouped in first-appearance order, so the transcript's cards and the recorded
 * revisions line up with the prose the pupil is reading.
 */
export interface ProjectWrite {
  /** The id every fence of this write carried, or null for a key-less block. */
  readonly key: string | null;
  /** The title the model gave it, from whichever fence carried one. */
  readonly title: string | null;
  /** Path → source, for the files this write states. */
  readonly files: Readonly<Record<string, string>>;
  /** Paths this write removes from the project. */
  readonly deletes: readonly string[];
  /** The path marked `entry`, when one was. */
  readonly entryHint: string | null;
  /** The paths written, in the order the model wrote them. */
  readonly writtenOrder: readonly string[];
  /**
   * Keyed fences that named no path.
   *
   * Almost always the entry written the old way — `\`\`\`html id=side` with no
   * `path=` — which the composer puts at the project's current entry.
   */
  readonly pathless: readonly DetectedArtifact[];
  /** True for a key-less block: one file, one artifact, the pre-project shape. */
  readonly single: DetectedArtifact | null;
  /** Where the write begins, for aligning cards with the prose. */
  readonly line: number;
  /** How many fences this write is made of, so a card can say "3 files". */
  readonly blocks: readonly DetectedArtifact[];
}

export function groupProjectWrites(detected: readonly DetectedArtifact[]): ProjectWrite[] {
  const writes: ProjectWrite[] = [];
  const byKey = new Map<string, number>();

  for (const block of detected) {
    // A block with no id is its own artifact, exactly as it always was: nothing
    // ties it to a neighbouring block, and merging two would be a guess.
    if (!block.key) {
      if (!block.language) continue;
      writes.push({
        key: null,
        title: block.title,
        files: {},
        deletes: [],
        entryHint: null,
        writtenOrder: [],
        pathless: [],
        single: block,
        line: block.line,
        blocks: [block],
      });
      continue;
    }

    const at = byKey.get(block.key);
    if (at === undefined) {
      byKey.set(block.key, writes.length);
      writes.push(startWrite(block));
      continue;
    }

    writes[at] = addBlock(writes[at], block);
  }

  return writes;
}

function startWrite(block: DetectedArtifact): ProjectWrite {
  return addBlock(
    {
      key: block.key,
      title: null,
      files: {},
      deletes: [],
      entryHint: null,
      writtenOrder: [],
      pathless: [],
      single: null,
      line: block.line,
      blocks: [],
    },
    block,
  );
}

function addBlock(write: ProjectWrite, block: DetectedArtifact): ProjectWrite {
  const blocks = [...write.blocks, block];
  // The first title wins, like every other attribute: a model that renames its
  // own artifact halfway down one message meant the name it opened with.
  const title = write.title ?? block.title;

  if (!block.path) {
    return { ...write, title, blocks, pathless: [...write.pathless, block] };
  }

  if (block.deleted) {
    return { ...write, title, blocks, deletes: [...write.deletes, block.path] };
  }

  return {
    ...write,
    title,
    blocks,
    files: { ...write.files, [block.path]: block.source },
    writtenOrder: [...write.writtenOrder, block.path],
    entryHint: block.entry ? block.path : write.entryHint,
  };
}
