import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateClassroomSettings } from "../db/queries/classrooms";
import { createConversation } from "../db/queries/conversations";
import { recordGeneratedImage } from "../db/queries/images";
import { appendMessage } from "../db/queries/messages";
import { searchConversations } from "../db/queries/search";
import { createSessionRow } from "../db/queries/sessions";
import { createTestDatabase, seedTestFixtures } from "../db/testing";
import { FileStore } from "../storage/files";
import { retentionCutoffs, runRetention } from "./retention";
import { sweepSessions } from "./sessions";

/**
 * Retention (PRD §16, §21).
 *
 * The two policies are separate on purpose, and the second test is the one that
 * matters: a classroom that has set no creations period keeps its pupils' work,
 * however old the conversation that produced it was.
 */

const NOW = new Date("2026-08-25T10:00:00Z");

function store(): FileStore {
  return new FileStore(mkdtempSync(join(tmpdir(), "setun-retention-")));
}

/** Backdate a row the schema stamps on insert. */
function backdate(db: ReturnType<typeof createTestDatabase>, sql: string, at: Date, id: string) {
  db.$client.query(sql).run(at.getTime(), id);
}

describe("retentionCutoffs", () => {
  it("subtracts the classroom's conversation policy", () => {
    const cutoffs = retentionCutoffs(
      { conversationRetentionDays: 30, creationRetentionDays: null },
      NOW,
    );
    expect(cutoffs.conversationsBefore).toEqual(new Date("2026-07-26T10:00:00Z"));
  });

  it("has no creations cut-off unless the classroom set one — the §16 default", () => {
    expect(
      retentionCutoffs({ conversationRetentionDays: 30, creationRetentionDays: null }, NOW)
        .creationsBefore,
    ).toBeNull();

    expect(
      retentionCutoffs({ conversationRetentionDays: 30, creationRetentionDays: 90 }, NOW)
        .creationsBefore,
    ).toEqual(new Date("2026-05-27T10:00:00Z"));
  });
});

describe("runRetention", () => {
  it("deletes an expired conversation, its messages and its search index entry", async () => {
    const db = createTestDatabase();
    const { student, alias } = seedTestFixtures(db);

    const old = createConversation(db, { studentId: student.id, modelAliasId: alias.id });
    appendMessage(db, {
      conversationId: old.id,
      parentId: null,
      role: "user",
      parts: [{ type: "text", text: "grundstoffer i det periodiske system" }],
    });
    backdate(
      db,
      "UPDATE conversation SET updatedAt = ? WHERE id = ?",
      new Date("2026-06-01T10:00:00Z"),
      old.id,
    );

    const outcome = await runRetention(db, store(), NOW);

    expect(outcome.conversations).toBe(1);
    expect(searchConversations(db, { studentId: student.id, query: "grundstoffer" })).toEqual([]);
    expect(db.$client.query("SELECT count(*) as n FROM message").get()).toEqual({ n: 0 });
  });

  it("leaves a conversation inside the policy alone", async () => {
    const db = createTestDatabase();
    const { student, alias } = seedTestFixtures(db);
    createConversation(db, { studentId: student.id, modelAliasId: alias.id });

    expect((await runRetention(db, store(), NOW)).conversations).toBe(0);
  });

  it("keeps creations when the classroom sets no creations period (§16)", async () => {
    const db = createTestDatabase();
    const { student, alias, classroom } = seedTestFixtures(db);

    const conversation = createConversation(db, {
      studentId: student.id,
      modelAliasId: alias.id,
    });
    const image = recordGeneratedImage(db, {
      studentId: student.id,
      conversationId: conversation.id,
      prompt: "en vulkan",
      mediaType: "image/png",
      storagePath: `images/${student.id}/${crypto.randomUUID()}.png`,
    });
    backdate(
      db,
      "UPDATE generated_image SET createdAt = ? WHERE id = ?",
      new Date("2024-01-01T10:00:00Z"),
      image.id,
    );
    backdate(
      db,
      "UPDATE conversation SET updatedAt = ? WHERE id = ?",
      new Date("2026-06-01T10:00:00Z"),
      conversation.id,
    );

    const kept = await runRetention(db, store(), NOW);
    expect(kept.conversations).toBe(1);
    expect(kept.images).toBe(0);

    // The same image goes once a period is set — the policy, not the age, decides.
    updateClassroomSettings(db, {
      classroomId: classroom.id,
      settings: { creationRetentionDays: 90 },
    });
    expect((await runRetention(db, store(), NOW)).images).toBe(1);
  });
});

describe("sweepSessions", () => {
  it("removes long-expired rows and keeps live ones", () => {
    const db = createTestDatabase();
    const { student } = seedTestFixtures(db);

    createSessionRow(db, {
      tokenDigest: "dead",
      ownerKind: "student",
      ownerId: student.id,
      expiresAt: new Date("2026-08-01T10:00:00Z"),
      createdAt: new Date("2026-07-01T10:00:00Z"),
    });
    createSessionRow(db, {
      tokenDigest: "live",
      ownerKind: "student",
      ownerId: student.id,
      expiresAt: new Date("2026-09-01T10:00:00Z"),
      createdAt: NOW,
    });

    expect(sweepSessions(db, NOW)).toBe(1);
    expect(db.$client.query("SELECT count(*) as n FROM session").get()).toEqual({ n: 1 });
  });

  it("keeps a row that expired inside the grace period", () => {
    const db = createTestDatabase();
    const { student } = seedTestFixtures(db);

    createSessionRow(db, {
      tokenDigest: "recent",
      ownerKind: "student",
      ownerId: student.id,
      expiresAt: new Date("2026-08-24T23:00:00Z"),
      createdAt: new Date("2026-08-10T10:00:00Z"),
    });

    expect(sweepSessions(db, NOW)).toBe(0);
  });
});
