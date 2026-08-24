import { beforeEach, describe, expect, it } from "bun:test";
import type { AppDatabase } from "../client";
import { createTestDatabase, seedTestFixtures } from "../testing";
import { listPendingAttachments, recordAttachmentWithinLimit } from "./attachments";
import { createConversation } from "./conversations";

/**
 * The per-message attachment cap, enforced where the row is written (PRD §10, §21).
 *
 * Counting in the route and inserting afterwards is two decisions with a gap
 * between them: the file write in between yields, and two uploads that each saw
 * "room for one more" both take it. The count and the insert are one
 * transaction so that the cap means what it says.
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

function upload(input: { maxPerMessage: number; conversationId?: string; studentId?: string }) {
  return recordAttachmentWithinLimit(db, {
    studentId: input.studentId ?? fixtures.student.id,
    conversationId: input.conversationId ?? conversationId,
    kind: "image",
    mediaType: "image/png",
    filename: "billede.png",
    byteSize: 1024,
    storagePath: `attachments/${crypto.randomUUID()}.png`,
    maxPerMessage: input.maxPerMessage,
  });
}

describe("recordAttachmentWithinLimit", () => {
  it("writes the row while the draft is under its cap", () => {
    const record = upload({ maxPerMessage: 2 });

    expect(record).not.toBeNull();
    expect(
      listPendingAttachments(db, { studentId: fixtures.student.id, conversationId }),
    ).toHaveLength(1);
  });

  it("refuses the row that would exceed the cap, and writes nothing", () => {
    expect(upload({ maxPerMessage: 2 })).not.toBeNull();
    expect(upload({ maxPerMessage: 2 })).not.toBeNull();

    // The refusal is the insert's own, so no caller can race past it.
    expect(upload({ maxPerMessage: 2 })).toBeNull();
    expect(
      listPendingAttachments(db, { studentId: fixtures.student.id, conversationId }),
    ).toHaveLength(2);
  });

  it("counts one draft only — another conversation's uploads do not fill this cap", () => {
    const other = createConversation(db, {
      studentId: fixtures.student.id,
      modelAliasId: fixtures.alias.id,
    }).id;

    expect(upload({ maxPerMessage: 1, conversationId: other })).not.toBeNull();
    expect(upload({ maxPerMessage: 1 })).not.toBeNull();

    expect(
      listPendingAttachments(db, { studentId: fixtures.student.id, conversationId }),
    ).toHaveLength(1);
  });
});
