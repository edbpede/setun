import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { ARTIFACT_LANGUAGES, BUILD_STATUSES, VERSION_AUTHORS } from "../../../artifacts/types";
import { conversation } from "./conversation";
import { createdAt, primaryId, updatedAt } from "./helpers";
import { message } from "./message";
import { student } from "./student";

/**
 * A thing the student built (PRD §13, §16, §19).
 *
 * "**Artifact** and **ArtifactVersion** — conversation and message references
 * (nullable, so creations outlive expired conversations), type, source, ordered
 * revisions."
 *
 * The references are nullable because creations are governed separately from
 * conversations: conversations expire after thirty days, while "by default they
 * persist until the student or educator deletes them (the gallery is the
 * student's portfolio)" (§16). The owner reference is not nullable — an artifact
 * without an owner is unreachable and unscopeable (§21).
 */
export const artifact = sqliteTable(
  "artifact",
  {
    id: primaryId(),
    studentId: text()
      .notNull()
      .references(() => student.id, { onDelete: "cascade" }),
    /** Null once the conversation that produced it has expired (§16). */
    conversationId: text().references(() => conversation.id, { onDelete: "set null" }),
    /** The §19 "type": the fence tag, which decides the renderer and the tier (§13). */
    language: text({ enum: ARTIFACT_LANGUAGES }).notNull(),
    /**
     * The id the model writes on the fence, and what continuity resolves on (§13).
     *
     * Null for an artifact whose model wrote none, and for every row that
     * predates the fence attribute; `effectiveArtifactKey` then derives one from
     * the identifier, so every artifact answers to a key whether or not it
     * stores one. Nullable rather than backfilled: the derivation is cheap and a
     * stored copy of a derived value is a second thing that can disagree.
     */
    key: text(),
    /** Read out of the source where it offers one; the interface names it otherwise. */
    title: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // Every read is owner-scoped (§21), so the owner leads the index.
    index("artifact_student_idx").on(t.studentId, t.updatedAt),
    // The continuity heuristic asks for the conversation's most recent artifact (§13).
    index("artifact_conversation_idx").on(t.conversationId, t.updatedAt),
    /**
     * And now for the conversation's artifact under a given key (§13).
     *
     * Plain, not unique. `conversationId` goes null when a conversation expires,
     * and a nulled row must not collide with a live one under the same key;
     * uniqueness within a live conversation holds by construction instead, since
     * recording is the only writer and resolves before it inserts.
     */
    index("artifact_conversation_key_idx").on(t.conversationId, t.key),
  ],
);

export type Artifact = typeof artifact.$inferSelect;

/**
 * One revision of an artifact's source (§13, §19).
 *
 * "Every edit is versioned, which yields undo, a diff view… and a creations
 * gallery." Versions are appended and never rewritten, so the diff a class
 * discusses — *what did the AI actually change?* — always has both sides.
 */
export const artifactVersion = sqliteTable(
  "artifact_version",
  {
    id: primaryId(),
    artifactId: text()
      .notNull()
      .references(() => artifact.id, { onDelete: "cascade" }),
    /** Null for a student's own edit, and once the message has expired (§16). */
    messageId: text().references(() => message.id, { onDelete: "set null" }),
    /** 1-based and contiguous per artifact: the "ordered revisions" of §19. */
    revision: integer().notNull(),
    source: text().notNull(),
    /**
     * The tag this revision was written under; null for "whatever the artifact
     * says" (§13).
     *
     * The artifact's own `language` is the current one and follows the key: a
     * page rewritten as a component under the same id is one thing, and the row
     * changes tag rather than forking. That leaves every older revision holding
     * a source written under a tag the row no longer names — and restoring one
     * ran an html file through the Svelte compiler. Additive and nullable rather
     * than backfilled: the rows that predate the column really are unknown.
     */
    language: text({ enum: ARTIFACT_LANGUAGES }),
    authoredBy: text({ enum: VERSION_AUTHORS }).notNull(),
    /**
     * When this version was carried to the model as the student's edited source.
     *
     * "When an artifact has been edited since the model last emitted it, the
     * next message in that conversation carries the current source" (§13) — the
     * *next* message, so a delivered edit is not sent again on every later turn.
     */
    deliveredAt: integer({ mode: "timestamp_ms" }),
    /**
     * What happened the last time this revision ran in the sandbox (§13).
     *
     * The browser is the only party that knows, so it reports the outcome back
     * onto the version it ran; the next turn's prompt then states it. Null means
     * "not run", which is the honest third value for a revision nobody has
     * pressed Run on — a version the model wrote and the pupil never opened.
     */
    buildStatus: text({ enum: BUILD_STATUSES }),
    /** The compiler's or the browser's own words. Text, never markup (§13, §21). */
    buildMessage: text(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("artifact_version_revision_idx").on(t.artifactId, t.revision)],
);

export type ArtifactVersion = typeof artifactVersion.$inferSelect;
