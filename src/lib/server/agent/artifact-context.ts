import { artifactLanguage } from "../../artifacts/detect";
import { fencedBlocks, fenceFor } from "../../artifacts/fences";
import { effectiveArtifactKey, fenceInfo, normaliseArtifactKey } from "../../artifacts/identity";
import type { ArtifactLanguage, BuildStatus, VersionAuthor } from "../../artifacts/types";
import type { AppDatabase } from "../db/client";
import { listConversationVersions } from "../db/queries/artifacts";
import type { Message, MessagePart } from "../db/schema";

/**
 * What the model is told about the artifacts it has already written (PRD §13).
 *
 * Three jobs, from one read of the conversation's versions:
 *
 * 1. **The state note.** A short list of what exists — id, language, revision,
 *    who wrote it last, and how it ran. Without it a model cannot know which id
 *    to reuse, and cannot know that the thing it wrote did not run at all.
 * 2. **Superseded-source elision.** Full rewrites are the update mechanism, so
 *    the path holds every version of every artifact in full. Left alone, a
 *    fourth revision of a page sends four copies of that page — the input grows
 *    without bound, and the model has three obsolete versions of its own file to
 *    confuse with the current one. So a block whose artifact's current source
 *    appears *later* in the same conversation is replaced by a line saying so.
 *
 * 3. **Carried sources.** The same read answers the opposite question: which
 *    artifacts' current sources the path does *not* hold. A pupil who edits an
 *    earlier prompt sends a path from a different branch of the message tree,
 *    and the artifact the model wrote on the branch they left is named by the
 *    state note and present nowhere. So its complete source travels behind the
 *    note, in the same never-persisted slot.
 *
 * The rule is deliberately conservative: nothing is elided unless the current
 * source is demonstrably present further down the same path. A block that is the
 * newest copy the model will see is always sent in full.
 *
 * Presence is decided by identity and not by text alone — a block counts for the
 * artifact its `id=` names, and an id-less block only when its text names exactly
 * one artifact. Both questions use the same rule, so an artifact can never be
 * both elided against a copy that is not its own and left uncarried because of it.
 */

/** Where one stored source sits: which artifact, which revision, and whether current. */
export interface ArtifactSourceRef {
  readonly artifactId: string;
  readonly key: string;
  readonly language: ArtifactLanguage;
  readonly revision: number;
  readonly isCurrent: boolean;
}

/** One line of the note: an artifact as it stands now. */
export interface ArtifactStateLine {
  readonly key: string;
  readonly language: ArtifactLanguage;
  readonly title: string | null;
  readonly revision: number;
  readonly authoredBy: VersionAuthor;
  readonly buildStatus: BuildStatus | null;
  readonly buildMessage: string | null;
}

/** An artifact whose current source no message on the path holds. */
export interface CarriedSource {
  readonly key: string;
  readonly language: ArtifactLanguage;
  readonly title: string | null;
  readonly revision: number;
  readonly source: string;
}

export interface ArtifactContext {
  /** Source text → every stored version holding exactly that text. */
  readonly index: ReadonlyMap<string, readonly ArtifactSourceRef[]>;
  readonly state: readonly ArtifactStateLine[];
  /** Current sources absent from the active path, to travel with the note. */
  readonly carried: readonly CarriedSource[];
}

export const EMPTY_ARTIFACT_CONTEXT: ArtifactContext = {
  index: new Map(),
  state: [],
  carried: [],
};

export function buildArtifactContext(
  db: AppDatabase,
  input: {
    conversationId: string;
    studentId: string;
    /** The active path, which decides what has to be carried rather than elided. */
    path: readonly Pick<Message, "role" | "parts">[];
  },
): ArtifactContext {
  const rows = listConversationVersions(db, input);

  // Ordered by artifact and then revision, so the last row of each group is the
  // current one and one pass is enough.
  const latest = new Map<string, (typeof rows)[number]>();
  for (const row of rows) latest.set(row.artifact.id, row);

  const index = new Map<string, ArtifactSourceRef[]>();
  for (const { artifact, version } of rows) {
    const refs = index.get(version.source) ?? [];
    refs.push({
      artifactId: artifact.id,
      key: effectiveArtifactKey(artifact),
      language: artifact.language,
      revision: version.revision,
      isCurrent: latest.get(artifact.id)?.version.id === version.id,
    });
    index.set(version.source, refs);
  }

  const state = [...latest.values()].map(({ artifact, version }) => ({
    key: effectiveArtifactKey(artifact),
    language: artifact.language,
    title: artifact.title,
    revision: version.revision,
    authoredBy: version.authoredBy,
    buildStatus: version.buildStatus ?? null,
    buildMessage: version.buildMessage ?? null,
  }));

  const held = currentSourcesOnPath(input.path, index);
  const carried = [...latest.values()]
    .filter(({ artifact }) => !held.has(artifact.id))
    .map(({ artifact, version }) => ({
      key: effectiveArtifactKey(artifact),
      language: artifact.language,
      title: artifact.title,
      revision: version.revision,
      source: version.source,
    }));

  return { index, state, carried };
}

/** An error message is a hint in a prompt, not a log; one line, bounded. */
const NOTE_MESSAGE_MAX = 300;

function collapse(message: string): string {
  return message.replace(/`/g, "").replace(/\s+/g, " ").trim().slice(0, NOTE_MESSAGE_MAX);
}

/**
 * The note itself, or null when the conversation has built nothing.
 *
 * Written to the model, so English and not a Paraglide message. It goes in as
 * the last text of the last user message rather than as a system message: it is
 * adjacent to the request it informs, it is identical on both gateway dialects,
 * it leaves the cacheable prefix alone, and it is never persisted — the note
 * describes the moment the turn was assembled and would be a lie afterwards.
 */
export function formatArtifactState(state: readonly ArtifactStateLine[]): string | null {
  if (state.length === 0) return null;

  const lines = state.map((item) => {
    const title = item.title ? ` "${collapse(item.title)}"` : "";
    const author = item.authoredBy === "model" ? "you" : "the pupil";
    const run =
      item.buildStatus === "failed"
        ? `last run failed: ${collapse(item.buildMessage ?? "no message")}`
        : item.buildStatus === "threw"
          ? `ran, then threw: ${collapse(item.buildMessage ?? "no message")}`
          : item.buildStatus === "ok"
            ? "last run: ok"
            : "not run yet";

    return `- id=${item.key} (${item.language})${title} — revision ${item.revision}, last written by ${author}, ${run}`;
  });

  return [
    "[The artifacts in this conversation. Reuse an id to change that artifact, writing the",
    "complete file again; use a new id for a separate thing.",
    ...lines,
    "]",
  ].join("\n");
}

/**
 * How much carried source one turn will send.
 *
 * Cumulative over the whole batch rather than per artifact: the failure being
 * bounded is a conversation with several large artifacts none of which is on the
 * path, where the sum is the problem and no single one of them is. Past the
 * bound the artifact is still named — a model told an artifact exists and shown
 * nothing asks about it, which is recoverable; a model shown nothing at all
 * rewrites it.
 */
export const CARRIED_MAX_CHARS = 200_000;

/**
 * The sources the path does not hold, or null when it holds them all.
 *
 * Written to the model, like the state note, and appended after it. Each source
 * arrives in the shape the model is asked to produce — the same info string
 * `fenceInfo` writes — so what it reads is a block it can copy the identity off
 * rather than one it has to translate.
 */
export function formatCarriedSources(carried: readonly CarriedSource[]): string | null {
  if (carried.length === 0) return null;

  const blocks: string[] = [];
  let used = 0;

  for (const item of carried) {
    const title = item.title ? ` "${collapse(item.title)}"` : "";
    const head = `The current version of id=${item.key} (${item.language})${title}, revision ${item.revision}, does not appear above.`;

    if (used + item.source.length > CARRIED_MAX_CHARS) {
      blocks.push(`[${head} Source omitted for length.]`);
      continue;
    }
    used += item.source.length;

    // Long enough for this source: an artifact holding a line of three backticks
    // would otherwise close its own fence and send the rest of itself as prose.
    const fence = fenceFor(item.source);

    blocks.push(
      [
        `[${head} This is its complete source; to change it, reuse id=${item.key} and write the complete file.]`,
        `${fence}${fenceInfo(item.language, { key: item.key, title: item.title })}`,
        item.source,
        fence,
      ].join("\n"),
    );
  }

  return blocks.join("\n\n");
}

/**
 * Which artifacts the path already holds the current source of.
 *
 * The map is artifact id → the last message index holding it, which is what the
 * elision below needs; a caller that only wants presence reads `has`.
 *
 * A block is placed by identity: the id its fence carries, or the id an
 * `artifact-edit` part names. Without that, a block belonging to one artifact
 * counts for another artifact holding the same text — which elides a source the
 * model still needs, and leaves an absent one uncarried.
 */
export function currentSourcesOnPath(
  path: readonly Pick<Message, "role" | "parts">[],
  index: ArtifactContext["index"],
): Map<string, number> {
  const currentAt = new Map<string, number>();
  if (index.size === 0) return currentAt;

  path.forEach((message, at) => {
    for (const block of blocksOf(message)) {
      for (const ref of placeBlock(index.get(block.source) ?? [], block.identity)) {
        if (ref.isCurrent) currentAt.set(ref.artifactId, at);
      }
    }
  });

  return currentAt;
}

/**
 * Replace obsolete copies of an artifact's source with a line naming them.
 *
 * Two passes, because the decision needs the whole path first: pass one finds,
 * per artifact, the last message that holds its *current* source; pass two
 * replaces every earlier recorded block of that artifact.
 *
 * Blocks are rewritten in reverse order within a message so the line indices of
 * the ones not yet rewritten stay valid.
 *
 * What is never touched: a block that was never recorded as an artifact (an
 * ordinary code block, an empty fence, a deleted or expired artifact), a block
 * whose artifact's current source is not on this path at all, and a block in the
 * same message as that current source.
 *
 * The index is keyed by source text, and two artifacts can hold the same text —
 * so a block is placed by the id it carries, or by the id an `artifact-edit`
 * part names, before anything is elided. Without that, a block belonging to one
 * artifact is elided against another artifact's later copy: the placeholder
 * names the wrong id, and a source the model still needs leaves the path.
 *
 * A block that names no id is placed only when the text itself names exactly one
 * artifact. The tag is not enough — two same-language artifacts holding the same
 * text is precisely the case above — and a guess here costs the model a file.
 */
export function elideSupersededArtifacts(
  path: readonly Pick<Message, "role" | "parts">[],
  index: ArtifactContext["index"],
): Pick<Message, "role" | "parts">[] {
  if (index.size === 0) return [...path];

  /** Artifact id → the last message index holding its current source. */
  const currentAt = currentSourcesOnPath(path, index);

  return path.map((message, at) => {
    /** Whether this ref's artifact has moved on further down the path. */
    const movedOn = (ref: ArtifactSourceRef): boolean => (currentAt.get(ref.artifactId) ?? -1) > at;

    // The ref that decides this source's fate: the block's own artifact, if its
    // current version is further down the path.
    const superseded = (source: string, identity: BlockIdentity): ArtifactSourceRef | null =>
      placeBlock(index.get(source) ?? [], identity).find(movedOn) ?? null;

    let changed = false;
    const parts = message.parts.map((part): MessagePart => {
      if (part.type === "artifact-edit") {
        const ref = superseded(part.source, { artifactId: part.artifactId });
        if (!ref) return part;

        changed = true;
        // An `artifact-edit` part is a whole block on its own, so the whole part
        // becomes the placeholder rather than being rewritten in place.
        return { type: "text", text: placeholder(ref) };
      }

      if (part.type !== "text") return part;

      const lines = part.text.split("\n");
      let rewritten = false;

      for (const block of [...fencedBlocks(part.text)].reverse()) {
        if (!artifactLanguage(block.language)) continue;

        const ref = superseded(block.source, { key: normaliseArtifactKey(block.attributes.id) });
        if (!ref) continue;

        lines.splice(block.line, block.endLine - block.line + 1, placeholder(ref));
        rewritten = true;
      }

      if (!rewritten) return part;
      changed = true;
      return { type: "text", text: lines.join("\n") };
    });

    return changed ? { ...message, parts } : message;
  });
}

/**
 * What a block says about which artifact it is.
 *
 * The id an `artifact-edit` part names is exact; the `id=` on a fence is what
 * the model itself wrote. A fence written before ids says nothing, and its tag
 * is not an identity — an artifact's language follows its key and can change
 * under it, so a block's tag matches neither one artifact nor only one.
 */
type BlockIdentity =
  | { readonly artifactId: string; readonly key?: undefined }
  | { readonly artifactId?: undefined; readonly key: string | null };

function owns(ref: ArtifactSourceRef, identity: BlockIdentity): boolean {
  return identity.artifactId !== undefined
    ? ref.artifactId === identity.artifactId
    : ref.key === identity.key;
}

/**
 * Which of a source's refs a block belongs to.
 *
 * Empty when nothing can be said: an unattributable block whose text two
 * artifacts hold. The tag is not enough — an artifact's language follows its key
 * and can change under it — and a guess here costs the model a file.
 */
function placeBlock(
  refs: readonly ArtifactSourceRef[],
  identity: BlockIdentity,
): readonly ArtifactSourceRef[] {
  if (refs.length === 0) return [];

  if (identity.artifactId !== undefined || identity.key !== null) {
    return refs.filter((ref) => owns(ref, identity));
  }

  const artifactIds = new Set(refs.map((ref) => ref.artifactId));
  return artifactIds.size === 1 ? refs : [];
}

/** Every artifact block a message holds, with what it says about its identity. */
function blocksOf(message: Pick<Message, "parts">): { source: string; identity: BlockIdentity }[] {
  return message.parts.flatMap((part) => {
    if (part.type === "artifact-edit") {
      return [{ source: part.source, identity: { artifactId: part.artifactId } }];
    }
    if (part.type !== "text") return [];

    return fencedBlocks(part.text)
      .filter((block) => artifactLanguage(block.language))
      .map((block) => ({
        source: block.source,
        identity: { key: normaliseArtifactKey(block.attributes.id) } as BlockIdentity,
      }));
  });
}

function placeholder(ref: ArtifactSourceRef): string {
  const what = ref.isCurrent
    ? "identical to the current version, which appears later in this conversation"
    : "superseded; the current version appears later in this conversation";

  return `[artifact id=${ref.key} (${ref.language}) revision ${ref.revision} — ${what}]`;
}
