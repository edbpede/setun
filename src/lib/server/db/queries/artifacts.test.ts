import { beforeEach, describe, expect, it } from "bun:test";
import { defaultPathFor } from "../../../artifacts/project";
import type { ArtifactLanguage } from "../../../artifacts/types";
import type { AppDatabase } from "../client";
import { createTestDatabase, seedTestFixtures } from "../testing";
import {
  appendSnapshot,
  createArtifact,
  deleteOwnedArtifact,
  getOwnedArtifact,
  hashContent,
  listArtifactVersions,
  listConversationAnchors,
  listConversationVersions,
  listVersionFiles,
  previousVersionIds,
  pruneOrphanBlobs,
  recordVersionBuild,
  snapshotOf,
  snapshotsOf,
  versionsByMessage,
} from "./artifacts";
import { createConversation } from "./conversations";
import { appendMessage } from "./messages";

/**
 * Append a one-file revision, the way every caller did before projects.
 *
 * These suites are about continuity, ordering and elision rather than about
 * file layout, so they keep saying "here is the source" and this puts it at the
 * conventional path for its language.
 */
function appendSource(
  db: AppDatabase,
  input: {
    artifactId: string;
    messageId?: string | null;
    source: string;
    language?: ArtifactLanguage | null;
    authoredBy: "model" | "student";
  },
) {
  const entry = defaultPathFor(input.language ?? "html");
  return appendSnapshot(db, { ...input, entry, files: { [entry]: input.source } });
}

/**
 * The build outcome a run writes back onto its version (PRD §13, §21).
 *
 * Owner-scoped in SQL like every other artifact read, and deliberately not a
 * write to the artifact's own recency: running something is not editing it.
 */

let db: AppDatabase;
let fixtures: ReturnType<typeof seedTestFixtures>;
let conversationId: string;

beforeEach(() => {
  db = createTestDatabase();
  fixtures = seedTestFixtures(db);
  conversationId = createConversation(db, {
    studentId: fixtures.student.id,
    modelAliasId: fixtures.alias.id,
  }).id;
});

function seedArtifact(key: string | null = "side") {
  const artifact = createArtifact(db, {
    studentId: fixtures.student.id,
    conversationId,
    language: "html",
    key,
    title: "Kort",
  });
  const version = appendSource(db, {
    artifactId: artifact.id,
    source: "<p>en</p>",
    authoredBy: "model",
  });

  return { artifact, version };
}

describe("appendSnapshot", () => {
  it("records the tag a revision was written under", () => {
    const { artifact } = seedArtifact();

    const version = appendSource(db, {
      artifactId: artifact.id,
      source: "<p>ny</p>",
      language: "svelte",
      authoredBy: "model",
    });

    expect(version.language).toBe("svelte");
  });

  it("leaves it null when the caller names none, which reads as the artifact's", () => {
    const { version } = seedArtifact();

    expect(version.language).toBeNull();
  });
});

describe("recordVersionBuild", () => {
  it("records what happened when the browser ran the version", () => {
    const { artifact, version } = seedArtifact();

    expect(
      recordVersionBuild(db, {
        artifactId: artifact.id,
        versionId: version.id,
        studentId: fixtures.student.id,
        status: "failed",
        message: "SyntaxError",
      }),
    ).toBe(true);

    const [stored] = listArtifactVersions(db, artifact.id);
    expect(stored.buildStatus).toBe("failed");
    expect(stored.buildMessage).toBe("SyntaxError");
  });

  it("does not make an artifact recent: running is not editing", () => {
    const { artifact, version } = seedArtifact();
    const before = getOwnedArtifact(db, {
      artifactId: artifact.id,
      studentId: fixtures.student.id,
    })?.updatedAt;

    recordVersionBuild(db, {
      artifactId: artifact.id,
      versionId: version.id,
      studentId: fixtures.student.id,
      status: "ok",
      message: null,
    });

    expect(
      getOwnedArtifact(db, { artifactId: artifact.id, studentId: fixtures.student.id })?.updatedAt,
    ).toEqual(before);
  });

  it("writes nothing for another student: absent, not forbidden", () => {
    const { artifact, version } = seedArtifact();
    const intruder = seedTestFixtures(db, { label: "quiet-fox", digest: crypto.randomUUID() });

    expect(
      recordVersionBuild(db, {
        artifactId: artifact.id,
        versionId: version.id,
        studentId: intruder.student.id,
        status: "failed",
        message: "hacked",
      }),
    ).toBe(false);
    expect(listArtifactVersions(db, artifact.id)[0].buildStatus).toBeNull();
  });

  it("writes nothing for a version belonging to another artifact", () => {
    const first = seedArtifact("en");
    const second = seedArtifact("to");

    expect(
      recordVersionBuild(db, {
        artifactId: first.artifact.id,
        versionId: second.version.id,
        studentId: fixtures.student.id,
        status: "failed",
        message: "boom",
      }),
    ).toBe(false);
    expect(listArtifactVersions(db, second.artifact.id)[0].buildStatus).toBeNull();
  });
});

describe("listConversationVersions", () => {
  it("returns every version of every artifact, ordered for one pass", () => {
    const { artifact } = seedArtifact();
    appendSource(db, {
      artifactId: artifact.id,
      source: "<p>to</p>",
      authoredBy: "model",
    });

    // A second artifact, because "every version of every artifact" is the
    // contract and one artifact cannot show that the groups stay together.
    const quiz = createArtifact(db, {
      studentId: fixtures.student.id,
      conversationId,
      language: "svg",
      key: "quiz",
    });
    for (const source of ["<svg>1</svg>", "<svg>2</svg>", "<svg>3</svg>"]) {
      appendSource(db, { artifactId: quiz.id, source, authoredBy: "model" });
    }

    const rows = listConversationVersions(db, {
      conversationId,
      studentId: fixtures.student.id,
    });

    // Grouped by artifact, each group by ascending revision: the caller folds
    // this in one pass and takes the last row of each group as the current one.
    // Which group comes first is `artifact.createdAt`, so the assertion asks
    // about the grouping rather than predicting the order of the two.
    const groups = rows.reduce<Record<string, number[]>>((held, row) => {
      held[row.artifact.id] = [...(held[row.artifact.id] ?? []), row.version.revision];
      return held;
    }, {});

    expect(groups).toEqual({ [artifact.id]: [1, 2], [quiz.id]: [1, 2, 3] });

    // And each artifact's rows are contiguous, which is what the one-pass fold
    // needs: collapsing consecutive repeats leaves one entry per artifact.
    const contiguous = rows
      .map((row) => row.artifact.id)
      .filter((id, index, all) => id !== all[index - 1]);

    expect(contiguous).toHaveLength(2);
  });

  it("is scoped to its owner", () => {
    seedArtifact();
    const intruder = seedTestFixtures(db, { label: "quiet-fox", digest: crypto.randomUUID() });

    expect(
      listConversationVersions(db, { conversationId, studentId: intruder.student.id }),
    ).toEqual([]);
  });
});

describe("listConversationAnchors", () => {
  it("orders two artifacts written in one millisecond by which revision landed last", () => {
    const first = seedArtifact("en");
    const second = seedArtifact("to");
    // Both rewritten in one message, in this order.
    appendSource(db, {
      artifactId: second.artifact.id,
      source: "<p>to igen</p>",
      authoredBy: "model",
    });
    appendSource(db, {
      artifactId: first.artifact.id,
      source: "<p>en igen</p>",
      authoredBy: "model",
    });

    const anchors = listConversationAnchors(db, {
      conversationId,
      studentId: fixtures.student.id,
    });
    const writtenAt = new Map(anchors.map((anchor) => [anchor.id, anchor.writtenAt]));

    expect(anchors).toHaveLength(2);
    // `updatedAt` can tie to the millisecond; the write order cannot.
    expect(writtenAt.get(first.artifact.id)).toBeGreaterThan(
      writtenAt.get(second.artifact.id) ?? 0,
    );
    expect(anchors.map((anchor) => anchor.key).sort()).toEqual(["en", "to"]);
  });

  it("is scoped to its owner", () => {
    seedArtifact();
    const intruder = seedTestFixtures(db, { label: "still-owl", digest: crypto.randomUUID() });

    expect(listConversationAnchors(db, { conversationId, studentId: intruder.student.id })).toEqual(
      [],
    );
  });
});

describe("versionsByMessage", () => {
  it("groups the versions a message wrote, in recording order", () => {
    // The failure this orders against: one message that rewrites an artifact
    // and creates another holds a later revision and a first, and by-revision
    // order puts them back to front — so the transcript's cards swap (§13).
    const side = createArtifact(db, {
      studentId: fixtures.student.id,
      conversationId,
      language: "html",
      key: "side",
    });
    for (const source of ["<p>en</p>", "<p>to</p>"]) {
      appendSource(db, { artifactId: side.id, source, authoredBy: "model" });
    }

    const message = appendMessage(db, {
      conversationId,
      parentId: null,
      role: "assistant",
      parts: [{ type: "text", text: "her" }],
    });
    const quiz = createArtifact(db, {
      studentId: fixtures.student.id,
      conversationId,
      language: "svg",
      key: "quiz",
    });

    // Written in this order: the third revision of `side`, then the first of
    // `quiz`, then a fourth of `side`.
    const written = [
      appendSource(db, {
        artifactId: side.id,
        messageId: message.id,
        source: "<p>tre</p>",
        authoredBy: "model",
      }),
      appendSource(db, {
        artifactId: quiz.id,
        messageId: message.id,
        source: "<svg>1</svg>",
        authoredBy: "model",
      }),
      appendSource(db, {
        artifactId: side.id,
        messageId: message.id,
        source: "<p>fire</p>",
        authoredBy: "model",
      }),
    ];

    const rows = versionsByMessage(db, [message.id]);

    expect(rows.map((row) => row.version.id)).toEqual(written.map((version) => version.id));
    expect(rows.map((row) => row.artifact.key)).toEqual(["side", "quiz", "side"]);
    expect(rows.map((row) => row.version.revision)).toEqual([3, 1, 4]);
  });

  it("holds nothing a different message wrote", () => {
    const first = appendMessage(db, {
      conversationId,
      parentId: null,
      role: "assistant",
      parts: [{ type: "text", text: "en" }],
    });
    const second = appendMessage(db, {
      conversationId,
      parentId: first.id,
      role: "assistant",
      parts: [{ type: "text", text: "to" }],
    });
    const { artifact } = seedArtifact();
    appendSource(db, {
      artifactId: artifact.id,
      messageId: second.id,
      source: "<p>to</p>",
      authoredBy: "model",
    });

    expect(versionsByMessage(db, [first.id])).toEqual([]);
    expect(versionsByMessage(db, [second.id])).toHaveLength(1);
  });

  it("has nothing to say about no messages", () => {
    expect(versionsByMessage(db, [])).toEqual([]);
  });
});

/**
 * Git's model in SQLite (PRD §13, §22).
 *
 * A pupil who changes one line of one file of a five-file project stores five
 * paths, four of which point at blobs that already existed. That sharing is what
 * makes per-file history affordable at all.
 */
describe("project snapshots", () => {
  function seedProject(files: Record<string, string>, entry = "src/App.tsx") {
    const record = createArtifact(db, {
      studentId: fixtures.student.id,
      conversationId,
      language: "tsx",
    });
    const version = appendSnapshot(db, {
      artifactId: record.id,
      entry,
      files,
      language: "tsx",
      authoredBy: "model",
    });

    return { record, version };
  }

  function blobCount(): number {
    return (db.$client.query("SELECT count(*) AS n FROM artifact_blob").get() as { n: number }).n;
  }

  it("batches immediate predecessors including edits outside the selected messages", () => {
    const first = seedProject({ "src/App.tsx": "first" });
    const edit = appendSnapshot(db, {
      artifactId: first.record.id,
      entry: "src/App.tsx",
      files: { "src/App.tsx": "student edit" },
      authoredBy: "student",
    });
    const next = appendSnapshot(db, {
      artifactId: first.record.id,
      entry: "src/App.tsx",
      files: { "src/App.tsx": "next answer" },
      authoredBy: "model",
    });
    const unrelated = seedProject({ "src/App.tsx": "another artifact" });

    expect(previousVersionIds(db, [first.version.id, next.id, unrelated.version.id])).toEqual(
      new Map([[next.id, edit.id]]),
    );
    expect(previousVersionIds(db, [])).toEqual(new Map());
  });

  it("reads a revision back as the project it was written as", () => {
    const { version } = seedProject({
      "src/App.tsx": "app",
      "src/data.ts": "data",
      "styles.css": "css",
    });

    expect(snapshotOf(db, version.id)).toEqual({
      entry: "src/App.tsx",
      files: { "src/App.tsx": "app", "src/data.ts": "data", "styles.css": "css" },
    });
  });

  it("stores one blob per distinct content, however many revisions hold it", () => {
    const { record } = seedProject({
      "src/App.tsx": "app",
      "src/data.ts": "data",
      "styles.css": "css",
    });
    expect(blobCount()).toBe(3);

    // A second revision that changes one file of three.
    appendSnapshot(db, {
      artifactId: record.id,
      entry: "src/App.tsx",
      files: { "src/App.tsx": "app v2", "src/data.ts": "data", "styles.css": "css" },
      language: "tsx",
      authoredBy: "student",
    });

    expect(blobCount()).toBe(4);
  });

  it("shares a blob between two artifacts that happen to hold the same file", () => {
    seedProject({ "src/App.tsx": "app", "styles.css": "delt" });
    seedProject({ "src/App.tsx": "andet", "styles.css": "delt" });

    expect(blobCount()).toBe(3);
  });

  it("fetches many revisions' files in one call", () => {
    const first = seedProject({ "src/App.tsx": "en" });
    const second = seedProject({ "src/App.tsx": "to", "b.css": "x" });

    const snapshots = snapshotsOf(db, [first.version.id, second.version.id]);

    expect(snapshots.get(first.version.id)?.files).toEqual({ "src/App.tsx": "en" });
    expect(snapshots.get(second.version.id)?.files).toEqual({ "src/App.tsx": "to", "b.css": "x" });
  });

  /** So a file called `__proto__` is a file rather than a way to reach Object (§21). */
  it("returns null-prototype file maps", () => {
    const { version } = seedProject({ "src/App.tsx": "app" });

    expect(Object.getPrototypeOf(snapshotOf(db, version.id)?.files)).toBeNull();
    expect(Object.getPrototypeOf(snapshotsOf(db, [version.id]).get(version.id)?.files)).toBeNull();
  });

  it("lists a revision's files with their sizes but not their content", () => {
    const { version } = seedProject({ "src/App.tsx": "app", "styles.css": "css!" });

    expect(listVersionFiles(db, [version.id])).toEqual([
      { versionId: version.id, path: "src/App.tsx", hash: hashContent("app"), bytes: 3 },
      { versionId: version.id, path: "styles.css", hash: hashContent("css!"), bytes: 4 },
    ]);
  });

  it("writes a revision and its files together or not at all", () => {
    const { record } = seedProject({ "src/App.tsx": "app" });

    // A path that violates the primary key: the same file twice in one write is
    // impossible through `asProjectFiles`, so this reaches for the guard itself.
    expect(() =>
      appendSnapshot(db, {
        artifactId: "does-not-exist",
        entry: "App.tsx",
        files: { "App.tsx": "x" },
        authoredBy: "model",
      }),
    ).toThrow();

    // The failed write left no revision behind on the artifact that does exist.
    expect(listArtifactVersions(db, record.id)).toHaveLength(1);
  });

  /**
   * A blob is shared, so it cannot cascade from the revision that happened to be
   * deleted — taking it would take it from every other revision holding it (§16).
   */
  it("sweeps blobs no revision holds any more", () => {
    const kept = seedProject({ "src/App.tsx": "beholdt", "styles.css": "delt" });
    const gone = seedProject({ "src/App.tsx": "forsvinder", "styles.css": "delt" });

    expect(blobCount()).toBe(3);
    deleteOwnedArtifact(db, { artifactId: gone.record.id, studentId: fixtures.student.id });

    // The revision's file rows cascaded, but the blobs are still there until swept.
    expect(pruneOrphanBlobs(db)).toBe(1);
    expect(blobCount()).toBe(2);
    // The shared stylesheet survived, because the other artifact still holds it.
    expect(snapshotOf(db, kept.version.id)?.files["styles.css"]).toBe("delt");
  });
});
