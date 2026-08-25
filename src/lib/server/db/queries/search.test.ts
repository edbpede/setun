import { describe, expect, it } from "bun:test";
import { createTestDatabase, seedTestFixtures } from "../testing";
import { createConversation, deleteConversation, setConversationTitle } from "./conversations";
import { appendMessage } from "./messages";
import { indexableText, searchConversations, toMatchExpression } from "./search";
import { createStudent } from "./students";

/**
 * Conversation search (PRD §10, §18, §21, §22).
 *
 * The security case §22 names — "cross-student access including search" — is the
 * last test here, and it is the reason search is scoped in SQL rather than
 * filtered afterwards.
 */

function withConversation(title?: string) {
  const db = createTestDatabase();
  const { classroom, alias, student } = seedTestFixtures(db);
  const conversation = createConversation(db, {
    studentId: student.id,
    modelAliasId: alias.id,
    ...(title ? { title } : {}),
  });
  return { db, classroom, alias, student, conversation };
}

describe("toMatchExpression", () => {
  it("quotes every token so FTS5 operators are inert", () => {
    expect(toMatchExpression("neural OR network")).toBe('"neural" "OR" "network"*');
  });

  it("prefix-matches the final token, because a search box is read as you type", () => {
    expect(toMatchExpression("neur")).toBe('"neur"*');
  });

  it("refuses punctuation-only input rather than building a malformed query", () => {
    expect(toMatchExpression("  *  ")).toBeNull();
    expect(toMatchExpression("")).toBeNull();
  });
});

describe("indexableText", () => {
  it("indexes prose and nothing else", () => {
    expect(
      indexableText([
        { type: "text", text: "how do layers pass information" },
        {
          type: "tool-call",
          toolCallId: "t1",
          toolName: "search",
          serverLabel: null,
          arguments: { q: "layers" },
          decision: "auto",
        },
      ]),
    ).toBe("how do layers pass information");
  });
});

describe("searchConversations", () => {
  it("finds a conversation by the text of one of its messages", () => {
    const { db, student, conversation } = withConversation();
    appendMessage(db, {
      conversationId: conversation.id,
      parentId: null,
      role: "user",
      parts: [{ type: "text", text: "forklar hvordan et neuralt netværk lærer" }],
    });

    const hits = searchConversations(db, { studentId: student.id, query: "neuralt" });
    expect(hits).toHaveLength(1);
    expect(hits[0].conversationId).toBe(conversation.id);
    expect(hits[0].excerpt).toContain("neuralt");
  });

  it("searches diacritics forgivingly, per the Appendix A tokenizer", () => {
    const { db, student, conversation } = withConversation();
    appendMessage(db, {
      conversationId: conversation.id,
      parentId: null,
      role: "user",
      parts: [{ type: "text", text: "hvordan får man ø-tegnet frem" }],
    });

    expect(searchConversations(db, { studentId: student.id, query: "far" })).toHaveLength(1);
  });

  it("finds a conversation by its title", () => {
    const { db, student, conversation } = withConversation();
    setConversationTitle(db, {
      conversationId: conversation.id,
      studentId: student.id,
      title: "Fotosyntese i planter",
    });

    const hits = searchConversations(db, { studentId: student.id, query: "fotosyntese" });
    expect(hits).toHaveLength(1);
    expect(hits[0].title).toBe("Fotosyntese i planter");
  });

  it("returns one hit per conversation however many messages match", () => {
    const { db, student, conversation } = withConversation();
    for (let i = 0; i < 4; i++) {
      appendMessage(db, {
        conversationId: conversation.id,
        parentId: null,
        role: "user",
        parts: [{ type: "text", text: `vektor nummer ${i}` }],
      });
    }

    expect(searchConversations(db, { studentId: student.id, query: "vektor" })).toHaveLength(1);
  });

  it("stops finding a conversation once it is deleted", () => {
    const { db, student, conversation } = withConversation();
    appendMessage(db, {
      conversationId: conversation.id,
      parentId: null,
      role: "user",
      parts: [{ type: "text", text: "polynomier" }],
    });

    deleteConversation(db, { conversationId: conversation.id, studentId: student.id });
    expect(searchConversations(db, { studentId: student.id, query: "polynomier" })).toEqual([]);
  });

  it("never returns another student's conversation (§21, §22)", () => {
    const { db, classroom, student, conversation } = withConversation();
    appendMessage(db, {
      conversationId: conversation.id,
      parentId: null,
      role: "user",
      parts: [{ type: "text", text: "hemmelig opgave om vulkaner" }],
    });

    const other = createStudent(db, {
      classroomId: classroom.id,
      label: "quiet-heron",
      credentialDigest: crypto.randomUUID(),
      credentialHint: "WXYZ",
    });

    expect(searchConversations(db, { studentId: other.id, query: "vulkaner" })).toEqual([]);
    expect(searchConversations(db, { studentId: student.id, query: "vulkaner" })).toHaveLength(1);
  });
});
