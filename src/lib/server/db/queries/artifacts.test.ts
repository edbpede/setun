import { beforeEach, describe, expect, it } from "bun:test";
import type { AppDatabase } from "../client";
import { createTestDatabase, seedTestFixtures } from "../testing";
import {
  appendArtifactVersion,
  createArtifact,
  getOwnedArtifact,
  listArtifactVersions,
  listConversationVersions,
  recordVersionBuild,
  versionsByMessage,
} from "./artifacts";
import { createConversation } from "./conversations";
import { appendMessage } from "./messages";

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
  const version = appendArtifactVersion(db, {
    artifactId: artifact.id,
    source: "<p>en</p>",
    authoredBy: "model",
  });

  return { artifact, version };
}

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
    appendArtifactVersion(db, {
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
      appendArtifactVersion(db, { artifactId: quiz.id, source, authoredBy: "model" });
    }

    const rows = listConversationVersions(db, {
      conversationId,
      studentId: fixtures.student.id,
    });

    // Grouped by artifact, each group by ascending revision: the caller folds
    // this in one pass and takes the last row of each group as the current one.
    const expected = [artifact.id, quiz.id].sort();
    expect(rows.map((row) => [row.artifact.id, row.version.revision])).toEqual(
      expected[0] === artifact.id
        ? [
            [artifact.id, 1],
            [artifact.id, 2],
            [quiz.id, 1],
            [quiz.id, 2],
            [quiz.id, 3],
          ]
        : [
            [quiz.id, 1],
            [quiz.id, 2],
            [quiz.id, 3],
            [artifact.id, 1],
            [artifact.id, 2],
          ],
    );
  });

  it("is scoped to its owner", () => {
    seedArtifact();
    const intruder = seedTestFixtures(db, { label: "quiet-fox", digest: crypto.randomUUID() });

    expect(
      listConversationVersions(db, { conversationId, studentId: intruder.student.id }),
    ).toEqual([]);
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
      appendArtifactVersion(db, { artifactId: side.id, source, authoredBy: "model" });
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
      appendArtifactVersion(db, {
        artifactId: side.id,
        messageId: message.id,
        source: "<p>tre</p>",
        authoredBy: "model",
      }),
      appendArtifactVersion(db, {
        artifactId: quiz.id,
        messageId: message.id,
        source: "<svg>1</svg>",
        authoredBy: "model",
      }),
      appendArtifactVersion(db, {
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
    appendArtifactVersion(db, {
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
