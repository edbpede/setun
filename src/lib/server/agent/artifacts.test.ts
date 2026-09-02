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
import { appendMessage, appendSibling, getActivePath } from "../db/queries/messages";
import { createTestDatabase, seedTestFixtures } from "../db/testing";
import { buildArtifactContext } from "./artifact-context";
import {
  markArtifactEditsDelivered,
  outgoingArtifactEditParts,
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
function assistantTurn(text: string, parentId: string | null = null) {
  const message = appendMessage(db, {
    conversationId,
    parentId,
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

  it("does not let another language steal the anchor", () => {
    // The observed failure: an interleaved drawing made the next page a fork.
    const page = assistantTurn("```html\n<p>en</p>\n```");
    assistantTurn("```svg\n<svg/>\n```");
    const again = assistantTurn("```html\n<p>to</p>\n```");

    expect(again[0].artifactId).toBe(page[0].artifactId);
    expect(listStudentArtifacts(db, fixtures.student.id)).toHaveLength(2);
  });

  it("keeps two ids apart, and follows one id across a language change", () => {
    const page = assistantTurn('```html id=side title="Min side"\n<p>en</p>\n```');
    const quiz = assistantTurn("```html id=quiz\n<p>quiz</p>\n```");
    expect(quiz[0].artifactId).not.toBe(page[0].artifactId);

    const rewritten = assistantTurn("```svelte id=side\n<p>en igen</p>\n```");
    expect(rewritten[0].artifactId).toBe(page[0].artifactId);

    const stored = getOwnedArtifact(db, {
      artifactId: page[0].artifactId,
      studentId: fixtures.student.id,
    });
    expect(stored?.language).toBe("svelte");
    expect(stored?.key).toBe("side");
    expect(listStudentArtifacts(db, fixtures.student.id)).toHaveLength(2);

    // The row's metadata following the id is only half of it: the rewrite is a
    // revision of that row, and a version that never landed would leave every
    // assertion above true and the pupil's page unchanged.
    const versions = listArtifactVersions(db, page[0].artifactId);
    expect(versions.map((version) => version.source)).toEqual(["<p>en</p>", "<p>en igen</p>"]);
    expect(versions.at(-1)?.id).toBe(rewritten[0].versionId);
    expect(rewritten[0].unchanged).toBe(false);
  });

  it("persists a fallback key the model adopted from the state note", () => {
    const [first] = assistantTurn("```html\n<p>en</p>\n```");
    const fallback = first.key;

    const again = assistantTurn(`\`\`\`html id=${fallback}\n<p>to</p>\n\`\`\``);

    expect(again[0].artifactId).toBe(first.artifactId);
    expect(
      getOwnedArtifact(db, { artifactId: first.artifactId, studentId: fixtures.student.id })?.key,
    ).toBe(fallback);
  });

  it("lets an explicit title rename, and reads one out of the source only while unnamed", () => {
    const [first] = assistantTurn("```html id=side\n<p>uden navn</p>\n```");
    expect(
      getOwnedArtifact(db, { artifactId: first.artifactId, studentId: fixtures.student.id })?.title,
    ).toBeNull();

    assistantTurn("```html id=side\n<title>Fundet</title>\n```");
    expect(
      getOwnedArtifact(db, { artifactId: first.artifactId, studentId: fixtures.student.id })?.title,
    ).toBe("Fundet");

    // A later source heading does not quietly retitle what is already named.
    assistantTurn("```html id=side\n<title>Noget andet</title><p>x</p>\n```");
    expect(
      getOwnedArtifact(db, { artifactId: first.artifactId, studentId: fixtures.student.id })?.title,
    ).toBe("Fundet");

    assistantTurn('```html id=side title="Valgt navn"\n<p>y</p>\n```');
    expect(
      getOwnedArtifact(db, { artifactId: first.artifactId, studentId: fixtures.student.id })?.title,
    ).toBe("Valgt navn");
  });

  it("appends no revision for an identical re-emission", () => {
    const [first] = assistantTurn("```html id=side\n<p>en</p>\n```");
    const again = assistantTurn("```html id=side\n<p>en</p>\n```");

    expect(again[0].unchanged).toBe(true);
    expect(again[0].versionId).toBe(first.versionId);
    expect(listArtifactVersions(db, first.artifactId)).toHaveLength(1);
  });

  it("appends a revision when only the tag changed", () => {
    const [first] = assistantTurn("```html id=side\n<p>en</p>\n```");
    const retagged = assistantTurn("```svelte id=side\n<p>en</p>\n```");

    // Same text, different pipeline. Left on the old revision the row would say
    // `svelte` while its current version still said `html`, and that is the tag
    // Restore and the sandbox both resolve through (§13).
    expect(retagged[0].unchanged).toBe(false);
    expect(retagged[0].versionId).not.toBe(first.versionId);

    const versions = listArtifactVersions(db, first.artifactId);
    expect(versions).toHaveLength(2);
    expect(versions.at(-1)?.language).toBe("svelte");
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

  it("carries the artifact's id, so the model can answer with a complete file", () => {
    const [recorded] = assistantTurn('```html id=side title="Kort"\n<p>en</p>\n```');
    appendArtifactVersion(db, {
      artifactId: recorded.artifactId,
      source: "<p>min rettelse</p>",
      authoredBy: "student",
    });

    const [part] = pendingArtifactEditParts(db, {
      conversationId,
      studentId: fixtures.student.id,
    });
    expect(part.key).toBe("side");

    const sent = String(
      assembleContext([{ role: "user", parts: [{ type: "text", text: "hjælp" }, part] }]).at(-1)
        ?.content,
    );
    expect(sent).toContain('```html id=side title="Kort"');
    expect(sent).toContain("To change it, reuse id=side and write the complete file.");
  });

  it("opens a longer fence for a pupil's page that holds a fence of its own", () => {
    const source = ["<p>Sådan:</p>", "```", "et loop", "```"].join("\n");
    const sent = String(
      assembleContext([
        {
          role: "user",
          parts: [
            {
              type: "artifact-edit",
              artifactId: crypto.randomUUID(),
              versionId: crypto.randomUUID(),
              language: "html",
              title: null,
              source,
              key: "side",
            },
          ],
        },
      ]).at(-1)?.content,
    );

    // A three-backtick fence closes on the artifact's own line, and everything
    // after it reaches the model as prose rather than as the pupil's file (§13).
    expect(sent).toContain("````html id=side");
    expect(sent).toContain(source);
    expect(sent.trimEnd().endsWith("````")).toBe(true);
  });

  it("encodes a part written before ids existed in the form it was written in", () => {
    const sent = String(
      assembleContext([
        {
          role: "user",
          parts: [
            {
              type: "artifact-edit",
              artifactId: crypto.randomUUID(),
              versionId: crypto.randomUUID(),
              language: "html",
              title: null,
              source: "<p>gammel</p>",
            },
          ],
        },
      ]).at(-1)?.content,
    );

    expect(sent).toContain("```html\n<p>gammel</p>");
    expect(sent).not.toContain("reuse id=");
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

describe("an edited prompt re-carrying what it replaces", () => {
  /** The state after a message carrying one student edit has been sent. */
  function sentWithEdit() {
    const [recorded] = assistantTurn("```html\n<p>en</p>\n```");
    appendArtifactVersion(db, {
      artifactId: recorded.artifactId,
      source: "<p>min rettelse</p>",
      authoredBy: "student",
    });

    const parts = outgoingArtifactEditParts(db, {
      conversationId,
      studentId: fixtures.student.id,
    });
    const prompt = appendMessage(db, {
      conversationId,
      parentId: null,
      role: "user",
      parts: [{ type: "text", text: "hjælp" }, ...parts],
    });
    markArtifactEditsDelivered(db, parts);

    return { recorded, prompt };
  }

  it("re-attaches the edit the replaced prompt was carrying", () => {
    const { recorded, prompt } = sentWithEdit();

    // The stamp says the revision was delivered — but only on a branch this
    // retry leaves behind, so the sibling has to carry it again.
    const retry = outgoingArtifactEditParts(db, {
      conversationId,
      studentId: fixtures.student.id,
      editOfMessageId: prompt.id,
    });

    expect(retry).toHaveLength(1);
    expect(retry[0]).toMatchObject({
      artifactId: recorded.artifactId,
      source: "<p>min rettelse</p>",
    });

    // And the retry's own path really does exclude the message it replaces.
    const sibling = appendSibling(db, {
      siblingOfId: prompt.id,
      conversationId,
      role: "user",
      parts: [{ type: "text", text: "igen" }, ...retry],
    });
    expect(getActivePath(db, sibling?.id ?? "").map((node) => node.id)).not.toContain(prompt.id);

    const sent = String(assembleContext(getActivePath(db, sibling?.id ?? "")).at(-1)?.content);
    expect(sent).toContain("<p>min rettelse</p>");
  });

  it("prefers a newer revision over the one the replaced prompt held", () => {
    const { recorded, prompt } = sentWithEdit();

    appendArtifactVersion(db, {
      artifactId: recorded.artifactId,
      source: "<p>endnu en rettelse</p>",
      authoredBy: "student",
    });

    const retry = outgoingArtifactEditParts(db, {
      conversationId,
      studentId: fixtures.student.id,
      editOfMessageId: prompt.id,
    });

    // One block, not two: the newer revision supersedes rather than joins it.
    expect(retry.map((part) => part.source)).toEqual(["<p>endnu en rettelse</p>"]);
  });

  it("carries the artifact as it stands now, not the snapshot that was sent", () => {
    const { recorded, prompt } = sentWithEdit();

    // A second revision, sent and stamped on the branch this retry abandons.
    appendArtifactVersion(db, {
      artifactId: recorded.artifactId,
      source: "<p>anden rettelse</p>",
      authoredBy: "student",
    });
    markArtifactEditsDelivered(
      db,
      outgoingArtifactEditParts(db, { conversationId, studentId: fixtures.student.id }),
    );

    const retry = outgoingArtifactEditParts(db, {
      conversationId,
      studentId: fixtures.student.id,
      editOfMessageId: prompt.id,
    });

    // The block says it is the current source, so it has to be the current one.
    expect(retry.map((part) => part.source)).toEqual(["<p>anden rettelse</p>"]);
  });

  it("carries nothing once the model has written the newer revision", () => {
    const { recorded, prompt } = sentWithEdit();

    appendArtifactVersion(db, {
      artifactId: recorded.artifactId,
      source: "<p>modellens svar</p>",
      authoredBy: "model",
    });

    // Not the student's to present as their own edit; their next edit of it
    // travels as an ordinary pending one.
    expect(
      outgoingArtifactEditParts(db, {
        conversationId,
        studentId: fixtures.student.id,
        editOfMessageId: prompt.id,
      }),
    ).toEqual([]);
  });

  it("carries nothing from a message belonging to another conversation", () => {
    const { prompt } = sentWithEdit();
    const other = createConversation(db, {
      studentId: fixtures.student.id,
      modelAliasId: fixtures.alias.id,
    }).id;

    expect(
      outgoingArtifactEditParts(db, {
        conversationId: other,
        studentId: fixtures.student.id,
        editOfMessageId: prompt.id,
      }),
    ).toEqual([]);
  });
});

describe("the language a version was written under", () => {
  it("records each revision's own tag while the row follows the newest", () => {
    const [first] = assistantTurn("```html id=side\n<p>en</p>\n```");
    assistantTurn("```svelte id=side\n<p>to</p>\n```");

    const versions = listArtifactVersions(db, first.artifactId);
    const row = getOwnedArtifact(db, {
      artifactId: first.artifactId,
      studentId: fixtures.student.id,
    });

    // One thing to the pupil, so the row changes tag rather than forking — but
    // restoring revision 1 must not hand an html file to the Svelte compiler.
    expect(row?.language).toBe("svelte");
    expect(versions.map((version) => version.language)).toEqual(["html", "svelte"]);
  });

  it("carries a pupil's edit under the tag their revision holds", () => {
    const [recorded] = assistantTurn("```html id=side\n<p>en</p>\n```");
    appendArtifactVersion(db, {
      artifactId: recorded.artifactId,
      source: "<p>min</p>",
      language: "html",
      authoredBy: "student",
    });
    // The model rewrites it as a component; the pupil's html edit is still html.
    assistantTurn("```svelte id=side\n<p>tre</p>\n```");
    appendArtifactVersion(db, {
      artifactId: recorded.artifactId,
      source: "<p>min igen</p>",
      language: "html",
      authoredBy: "student",
    });

    const [part] = pendingArtifactEditParts(db, {
      conversationId,
      studentId: fixtures.student.id,
    });

    expect(part.language).toBe("html");
  });
});

describe("an artifact whose newest revision is off the active path", () => {
  it("carries its complete source into the request the branch assembles", () => {
    // Turn one writes the page, turn two revises it. Then the pupil edits the
    // first prompt, which sends a path from a branch on which revision 2 never
    // happened — the state note names it and nothing holds it (§10, §13).
    const first = appendMessage(db, {
      conversationId,
      parentId: null,
      role: "user",
      parts: [{ type: "text", text: "byg en side" }],
    });
    assistantTurn("```html id=side\n<p>en</p>\n```", first.id);
    const second = appendMessage(db, {
      conversationId,
      parentId: null,
      role: "user",
      parts: [{ type: "text", text: "gør den blå" }],
    });
    assistantTurn("```html id=side\n<p>to</p>\n```", second.id);

    const sibling = appendSibling(db, {
      siblingOfId: first.id,
      conversationId,
      role: "user",
      parts: [{ type: "text", text: "byg en side, men grøn" }],
    });
    const path = getActivePath(db, sibling?.id ?? "");
    const artifacts = buildArtifactContext(db, {
      conversationId,
      studentId: fixtures.student.id,
      path,
    });

    const sent = String(assembleContext(path, undefined, undefined, artifacts).at(-1)?.content);

    expect(sent).toContain("byg en side, men grøn");
    expect(sent).toContain("id=side (html) — revision 2");
    // Without this the model rewrote revision 2 from a copy it could not see.
    expect(sent).toContain("does not appear above");
    expect(sent).toContain("<p>to</p>");
  });
});
