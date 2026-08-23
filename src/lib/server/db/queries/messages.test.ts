import { beforeEach, describe, expect, it } from "bun:test";
import type { AppDatabase } from "../client";
import { createTestDatabase, seedTestFixtures } from "../testing";
import {
  createConversation,
  deleteConversation,
  getOwnedConversation,
  listConversations,
  setActiveLeaf,
} from "./conversations";
import {
  appendMessage,
  appendSibling,
  getActivePath,
  listChildren,
  listConversationMessages,
  recordMessageUsage,
} from "./messages";

/**
 * Message-tree invariants and query-module round trips (plan 1.2, PRD §10, §22).
 */

let db: AppDatabase;
let fixtures: ReturnType<typeof seedTestFixtures>;

beforeEach(() => {
  db = createTestDatabase();
  fixtures = seedTestFixtures(db);
});

function newConversation() {
  return createConversation(db, {
    studentId: fixtures.student.id,
    modelAliasId: fixtures.alias.id,
  });
}

describe("message tree", () => {
  it("appends a root message with no parent", () => {
    const conversation = newConversation();
    const root = appendMessage(db, {
      conversationId: conversation.id,
      parentId: null,
      role: "user",
      parts: [{ type: "text", text: "Hello" }],
    });

    expect(root.parentId).toBeNull();
    expect(root.parts).toEqual([{ type: "text", text: "Hello" }]);
  });

  it("returns the root-to-leaf path oldest first", () => {
    const conversation = newConversation();
    const first = appendMessage(db, {
      conversationId: conversation.id,
      parentId: null,
      role: "user",
      parts: [{ type: "text", text: "one" }],
    });
    const second = appendMessage(db, {
      conversationId: conversation.id,
      parentId: first.id,
      role: "assistant",
      parts: [{ type: "text", text: "two" }],
    });
    const third = appendMessage(db, {
      conversationId: conversation.id,
      parentId: second.id,
      role: "user",
      parts: [{ type: "text", text: "three" }],
    });

    expect(getActivePath(db, third.id).map((m) => m.id)).toEqual([first.id, second.id, third.id]);
  });

  it("creates a sibling sharing the original's parent, leaving the original intact", () => {
    const conversation = newConversation();
    const prompt = appendMessage(db, {
      conversationId: conversation.id,
      parentId: null,
      role: "user",
      parts: [{ type: "text", text: "original prompt" }],
    });
    const answer = appendMessage(db, {
      conversationId: conversation.id,
      parentId: prompt.id,
      role: "assistant",
      parts: [{ type: "text", text: "original answer" }],
    });

    // Regenerating: a second assistant message under the same prompt.
    const regenerated = appendSibling(db, {
      siblingOfId: answer.id,
      role: "assistant",
      parts: [{ type: "text", text: "second answer" }],
    });

    expect(regenerated?.parentId).toBe(prompt.id);
    expect(regenerated?.id).not.toBe(answer.id);
    // The original branch survives — nothing is overwritten.
    expect(
      listChildren(db, prompt.id)
        .map((m) => m.id)
        .sort(),
    ).toEqual([answer.id, regenerated?.id].sort() as string[]);
  });

  it("branches an edited prompt as a sibling at the same depth", () => {
    const conversation = newConversation();
    const prompt = appendMessage(db, {
      conversationId: conversation.id,
      parentId: null,
      role: "user",
      parts: [{ type: "text", text: "first try" }],
    });

    const edited = appendSibling(db, {
      siblingOfId: prompt.id,
      role: "user",
      parts: [{ type: "text", text: "second try" }],
    });

    expect(edited?.parentId).toBeNull();
    expect(getActivePath(db, edited?.id ?? "")).toHaveLength(1);
  });

  it("returns undefined when the sibling target does not exist", () => {
    expect(appendSibling(db, { siblingOfId: "missing", role: "user", parts: [] })).toBeUndefined();
  });

  it("tracks the active leaf across a branch switch", () => {
    const conversation = newConversation();
    const prompt = appendMessage(db, {
      conversationId: conversation.id,
      parentId: null,
      role: "user",
      parts: [{ type: "text", text: "q" }],
    });
    const answer = appendMessage(db, {
      conversationId: conversation.id,
      parentId: prompt.id,
      role: "assistant",
      parts: [{ type: "text", text: "a1" }],
    });
    setActiveLeaf(db, {
      conversationId: conversation.id,
      studentId: fixtures.student.id,
      messageId: answer.id,
    });

    const regenerated = appendSibling(db, {
      siblingOfId: answer.id,
      role: "assistant",
      parts: [{ type: "text", text: "a2" }],
    });
    setActiveLeaf(db, {
      conversationId: conversation.id,
      studentId: fixtures.student.id,
      messageId: regenerated?.id ?? "",
    });

    const reloaded = getOwnedConversation(db, {
      conversationId: conversation.id,
      studentId: fixtures.student.id,
    });
    expect(reloaded?.activeLeafId).toBe(regenerated?.id ?? "");
    // Both variants remain in the conversation.
    expect(listConversationMessages(db, conversation.id)).toHaveLength(3);
  });

  it("records usage on a message, flagged when estimated", () => {
    const conversation = newConversation();
    const answer = appendMessage(db, {
      conversationId: conversation.id,
      parentId: null,
      role: "assistant",
      parts: [{ type: "text", text: "a" }],
    });

    recordMessageUsage(db, {
      messageId: answer.id,
      inputTokens: 12,
      outputTokens: 34,
      estimated: true,
    });

    const [reloaded] = listConversationMessages(db, conversation.id);
    expect(reloaded.inputTokens).toBe(12);
    expect(reloaded.outputTokens).toBe(34);
    expect(reloaded.usageEstimated).toBe(true);
  });
});

describe("conversation ownership", () => {
  it("does not resolve another student's conversation", () => {
    const conversation = newConversation();
    const other = seedTestFixtures(db, { label: "quiet-heron", digest: "other-digest" });

    expect(
      getOwnedConversation(db, {
        conversationId: conversation.id,
        studentId: other.student.id,
      }),
    ).toBeUndefined();
  });

  it("lists only the requesting student's conversations", () => {
    newConversation();
    const other = seedTestFixtures(db, { label: "quiet-heron", digest: "other-digest" });
    createConversation(db, { studentId: other.student.id, modelAliasId: other.alias.id });

    expect(listConversations(db, fixtures.student.id)).toHaveLength(1);
    expect(listConversations(db, other.student.id)).toHaveLength(1);
  });

  it("refuses to delete another student's conversation", () => {
    const conversation = newConversation();
    const other = seedTestFixtures(db, { label: "quiet-heron", digest: "other-digest" });

    expect(
      deleteConversation(db, {
        conversationId: conversation.id,
        studentId: other.student.id,
      }),
    ).toBe(false);
    expect(listConversations(db, fixtures.student.id)).toHaveLength(1);
  });

  it("deletes a conversation and cascades its messages", () => {
    const conversation = newConversation();
    appendMessage(db, {
      conversationId: conversation.id,
      parentId: null,
      role: "user",
      parts: [{ type: "text", text: "hi" }],
    });

    expect(
      deleteConversation(db, {
        conversationId: conversation.id,
        studentId: fixtures.student.id,
      }),
    ).toBe(true);
    expect(listConversationMessages(db, conversation.id)).toHaveLength(0);
  });
});
