import { beforeEach, describe, expect, it } from "bun:test";
import type { AppDatabase } from "../db/client";
import {
  appendArtifactVersion,
  getOwnedArtifact,
  listArtifactVersions,
  listConversationArtifacts,
  listStudentArtifacts,
} from "../db/queries/artifacts";
import { createConversation } from "../db/queries/conversations";
import { appendMessage } from "../db/queries/messages";
import { createTestDatabase, seedTestFixtures } from "../db/testing";
import {
  markArtifactEditsDelivered,
  pendingArtifactEditParts,
  recordTurnArtifacts,
} from "./artifacts";
import { assembleContext } from "./loop";

/**
 * Artifacts recorded from a turn, and the student's edit travelling back
 * (plan 4.2, 4.4; PRD §13, §16, §19, §22).
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

/** Persist an assistant message carrying `text`, then record its artifacts. */
function assistantTurn(text: string) {
  const message = appendMessage(db, {
    conversationId,
    parentId: null,
    role: "assistant",
    parts: [{ type: "text", text }],
  });

  return recordTurnArtifacts(db, {
    studentId: fixtures.student.id,
    conversationId,
    messageId: message.id,
    parts: [{ type: "text", text }],
  });
}

describe("recordTurnArtifacts", () => {
  it("records an artifact and its first revision", () => {
    const recorded = assistantTurn("Her er siden:\n```html\n<title>Kort</title>\n```");

    expect(recorded).toHaveLength(1);

    const stored = getOwnedArtifact(db, {
      artifactId: recorded[0].artifactId,
      studentId: fixtures.student.id,
    });
    expect(stored?.language).toBe("html");
    // The name comes out of the source itself; the interface names it otherwise.
    expect(stored?.title).toBe("Kort");

    const versions = listArtifactVersions(db, recorded[0].artifactId);
    expect(versions).toHaveLength(1);
    expect(versions[0].revision).toBe(1);
    expect(versions[0].authoredBy).toBe("model");
  });

  it("ignores blocks that are not artifact languages", () => {
    expect(assistantTurn("```js\nconst x = 1;\n```")).toEqual([]);
    expect(listStudentArtifacts(db, fixtures.student.id)).toEqual([]);
  });

  it("versions the same artifact when the language matches", () => {
    const first = assistantTurn("```html\n<p>en</p>\n```");
    const second = assistantTurn("```html\n<p>to</p>\n```");

    expect(second[0].artifactId).toBe(first[0].artifactId);
    expect(listArtifactVersions(db, first[0].artifactId).map((v) => v.revision)).toEqual([1, 2]);
    expect(
      listConversationArtifacts(db, { conversationId, studentId: fixtures.student.id }),
    ).toHaveLength(1);
  });

  it("starts a new artifact when the language differs", () => {
    const first = assistantTurn("```html\n<p>en</p>\n```");
    const second = assistantTurn("```tsx\nexport default () => <p>to</p>;\n```");

    expect(second[0].artifactId).not.toBe(first[0].artifactId);
    expect(listStudentArtifacts(db, fixtures.student.id)).toHaveLength(2);
  });

  it("keeps every revision, so a wrong continuity guess loses nothing", () => {
    assistantTurn("```html\n<p>en</p>\n```");
    assistantTurn("```html\n<p>to</p>\n```");
    assistantTurn("```html\n<p>tre</p>\n```");

    const [{ artifact }] = listStudentArtifacts(db, fixtures.student.id);
    expect(listArtifactVersions(db, artifact.id).map((v) => v.source)).toEqual([
      "<p>en</p>",
      "<p>to</p>",
      "<p>tre</p>",
    ]);
  });
});

describe("the student's edit travelling back to the model", () => {
  it("carries an edited artifact on the next message and only that one", () => {
    const [recorded] = assistantTurn("```html\n<p>en</p>\n```");

    // Nothing to carry while the newest revision is the model's own.
    expect(
      pendingArtifactEditParts(db, { conversationId, studentId: fixtures.student.id }),
    ).toEqual([]);

    appendArtifactVersion(db, {
      artifactId: recorded.artifactId,
      source: "<p>min rettelse</p>",
      authoredBy: "student",
    });

    const parts = pendingArtifactEditParts(db, {
      conversationId,
      studentId: fixtures.student.id,
    });
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({
      type: "artifact-edit",
      artifactId: recorded.artifactId,
      language: "html",
      source: "<p>min rettelse</p>",
    });

    // "The *next* message" — once carried, it is not repeated on every later turn.
    markArtifactEditsDelivered(db, parts);
    expect(
      pendingArtifactEditParts(db, { conversationId, studentId: fixtures.student.id }),
    ).toEqual([]);
  });

  it("carries a further edit made after the first was delivered", () => {
    const [recorded] = assistantTurn("```html\n<p>en</p>\n```");

    appendArtifactVersion(db, {
      artifactId: recorded.artifactId,
      source: "<p>første</p>",
      authoredBy: "student",
    });
    markArtifactEditsDelivered(
      db,
      pendingArtifactEditParts(db, { conversationId, studentId: fixtures.student.id }),
    );

    appendArtifactVersion(db, {
      artifactId: recorded.artifactId,
      source: "<p>anden</p>",
      authoredBy: "student",
    });

    const parts = pendingArtifactEditParts(db, {
      conversationId,
      studentId: fixtures.student.id,
    });
    expect(parts.map((part) => part.source)).toEqual(["<p>anden</p>"]);
  });

  it("sends the edited source upstream, marked as the student's own", () => {
    const context = assembleContext([
      {
        role: "user",
        parts: [
          { type: "text", text: "Jeg ødelagde den — kan du hjælpe?" },
          {
            type: "artifact-edit",
            artifactId: crypto.randomUUID(),
            versionId: crypto.randomUUID(),
            language: "html",
            title: "Kort",
            source: "<p>min rettelse</p>",
          },
        ],
      },
    ]);

    const sent = String(context.at(-1)?.content);
    expect(sent).toContain("Jeg ødelagde den");
    expect(sent).toContain("student's edited version");
    expect(sent).toContain("<p>min rettelse</p>");
  });

  it("is scoped to its owner: another student's edit never travels", () => {
    const [recorded] = assistantTurn("```html\n<p>en</p>\n```");
    appendArtifactVersion(db, {
      artifactId: recorded.artifactId,
      source: "<p>min rettelse</p>",
      authoredBy: "student",
    });

    const intruder = seedTestFixtures(db, { label: "quiet-fox", digest: crypto.randomUUID() });

    expect(
      pendingArtifactEditParts(db, { conversationId, studentId: intruder.student.id }),
    ).toEqual([]);
    expect(
      getOwnedArtifact(db, {
        artifactId: recorded.artifactId,
        studentId: intruder.student.id,
      }),
    ).toBeUndefined();
  });
});
