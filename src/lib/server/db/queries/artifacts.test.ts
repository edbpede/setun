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

    const rows = listConversationVersions(db, {
      conversationId,
      studentId: fixtures.student.id,
    });

    expect(rows.map((row) => row.version.revision)).toEqual([1, 2]);
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
    const message = appendMessage(db, {
      conversationId,
      parentId: null,
      role: "assistant",
      parts: [{ type: "text", text: "her" }],
    });
    const artifact = createArtifact(db, {
      studentId: fixtures.student.id,
      conversationId,
      language: "html",
      key: "side",
    });
    appendArtifactVersion(db, {
      artifactId: artifact.id,
      messageId: message.id,
      source: "<p>en</p>",
      authoredBy: "model",
    });

    const rows = versionsByMessage(db, [message.id]);

    expect(rows).toHaveLength(1);
    expect(rows[0].artifact.key).toBe("side");
  });

  it("has nothing to say about no messages", () => {
    expect(versionsByMessage(db, [])).toEqual([]);
  });
});
