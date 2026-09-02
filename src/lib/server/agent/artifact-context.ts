import { artifactLanguage } from "../../artifacts/detect";
import { fencedBlocks } from "../../artifacts/fences";
import { effectiveArtifactKey } from "../../artifacts/identity";
import type { ArtifactLanguage, BuildStatus, VersionAuthor } from "../../artifacts/types";
import type { AppDatabase } from "../db/client";
import { listConversationVersions } from "../db/queries/artifacts";
import type { Message, MessagePart } from "../db/schema";

/**
 * What the model is told about the artifacts it has already written (PRD §13).
 *
 * Two jobs, from one read of the conversation's versions:
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
 * The rule is deliberately conservative: nothing is elided unless the current
 * source is demonstrably present further down the same path. A block that is the
 * newest copy the model will see is always sent in full.
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

export interface ArtifactContext {
  /** Source text → every stored version holding exactly that text. */
  readonly index: ReadonlyMap<string, readonly ArtifactSourceRef[]>;
  readonly state: readonly ArtifactStateLine[];
}

export const EMPTY_ARTIFACT_CONTEXT: ArtifactContext = { index: new Map(), state: [] };

export function buildArtifactContext(
  db: AppDatabase,
  input: { conversationId: string; studentId: string },
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

  return { index, state };
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
 */
export function elideSupersededArtifacts(
  path: readonly Pick<Message, "role" | "parts">[],
  index: ArtifactContext["index"],
): Pick<Message, "role" | "parts">[] {
  if (index.size === 0) return [...path];

  /** Artifact id → the last message index holding its current source. */
  const currentAt = new Map<string, number>();

  const refsFor = (source: string): readonly ArtifactSourceRef[] => index.get(source) ?? [];

  path.forEach((message, at) => {
    for (const source of sourcesOf(message)) {
      for (const ref of refsFor(source)) {
        if (ref.isCurrent) currentAt.set(ref.artifactId, at);
      }
    }
  });

  return path.map((message, at) => {
    // The ref that decides this source's fate: the first whose artifact has its
    // current version further down the path.
    const superseded = (source: string): ArtifactSourceRef | null =>
      refsFor(source).find((ref) => (currentAt.get(ref.artifactId) ?? -1) > at) ?? null;

    let changed = false;
    const parts = message.parts.map((part): MessagePart => {
      if (part.type === "artifact-edit") {
        const ref = superseded(part.source);
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

        const ref = superseded(block.source);
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

/** Every artifact source a message holds, from either kind of part. */
function sourcesOf(message: Pick<Message, "parts">): string[] {
  return message.parts.flatMap((part) => {
    if (part.type === "artifact-edit") return [part.source];
    if (part.type !== "text") return [];

    return fencedBlocks(part.text)
      .filter((block) => artifactLanguage(block.language))
      .map((block) => block.source);
  });
}

function placeholder(ref: ArtifactSourceRef): string {
  const what = ref.isCurrent
    ? "identical to the current version, which appears later in this conversation"
    : "superseded; the current version appears later in this conversation";

  return `[artifact id=${ref.key} (${ref.language}) revision ${ref.revision} — ${what}]`;
}
