import { error, json } from "@sveltejs/kit";
import { requireStudentApi } from "$lib/server/auth/guards";
import { getDb, getFileStore } from "$lib/server/boot";
import { resolveAttachmentPolicy } from "$lib/server/classroom/settings";
import { listPendingAttachments, recordAttachment } from "$lib/server/db/queries/attachments";
import { getClassroom } from "$lib/server/db/queries/classrooms";
import { getOwnedConversation } from "$lib/server/db/queries/conversations";
import { getAliasById } from "$lib/server/db/queries/model-aliases";
import { inlineTextAttachment, validateAttachment } from "$lib/server/storage/attachments";
import { extensionFor } from "$lib/server/storage/files";
import type { RequestHandler } from "./$types";

/**
 * Upload one attachment (PRD §10, §21).
 *
 * Thin by §6.1. Everything that decides whether the file is acceptable lives in
 * `$lib/server/storage/attachments`; what happens here is the ownership check,
 * the policy resolution, and writing the row.
 *
 * The declared content type is never trusted: the bytes are sniffed, and the
 * sniffed type is what is stored and later served (§21).
 */
export const POST: RequestHandler = async ({ request, locals }) => {
  const student = requireStudentApi(locals);
  const db = getDb();

  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  const conversationId = String(form?.get("conversationId") ?? "");

  if (!(file instanceof File) || !conversationId) error(400, "Invalid request");

  // Another student's conversation is absent, not forbidden (§21).
  const conversation = getOwnedConversation(db, { conversationId, studentId: student.id });
  if (!conversation) error(404, "Not found");

  const classroom = getClassroom(db, student.classroomId);
  const alias = getAliasById(db, conversation.modelAliasId);
  if (!classroom || !alias) error(409, "Unavailable");

  const bytes = new Uint8Array(await file.arrayBuffer());
  const validation = validateAttachment({
    bytes,
    policy: resolveAttachmentPolicy(classroom, student, alias),
    existingCount: listPendingAttachments(db, { studentId: student.id, conversationId }).length,
  });

  if (!validation.ok) {
    // A machine-readable code; the browser renders its own sentence (§10, §21).
    return json({ error: validation.refusal }, { status: 422 });
  }

  const filename = safeFilename(file.name);

  // Text and code files are inlined into the message as text (§10), so what is
  // stored for them is the fenced form the loop will send — the raw bytes are
  // not needed twice, and one representation cannot drift from the other.
  const stored = await getFileStore().write({
    category: "attachments",
    ownerId: student.id,
    bytes:
      validation.kind === "text"
        ? new TextEncoder().encode(inlineTextAttachment(filename, bytes))
        : bytes,
    extension: validation.kind === "text" ? "txt" : extensionFor(validation.mediaType),
  });

  const record = recordAttachment(db, {
    studentId: student.id,
    conversationId,
    kind: validation.kind,
    mediaType: validation.mediaType,
    filename,
    byteSize: stored.byteSize,
    storagePath: stored.storagePath,
  });

  return json(
    {
      id: record.id,
      filename: record.filename,
      kind: record.kind,
      mediaType: record.mediaType,
      byteSize: record.byteSize,
    },
    { status: 201 },
  );
};

/** The pending uploads for one conversation — what the composer shows as chips. */
export const GET: RequestHandler = ({ url, locals }) => {
  const student = requireStudentApi(locals);
  const conversationId = url.searchParams.get("conversationId");
  if (!conversationId) error(400, "Invalid request");

  const pending = listPendingAttachments(getDb(), { studentId: student.id, conversationId });

  return json({
    attachments: pending.map((file) => ({
      id: file.id,
      filename: file.filename,
      kind: file.kind,
      mediaType: file.mediaType,
      byteSize: file.byteSize,
    })),
  });
};

/**
 * A filename safe to echo back and to put in a header.
 *
 * The name comes from the student's own device and is displayed to them; it is
 * never a path, and never reaches the filesystem — the stored name is a UUID.
 */
function safeFilename(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? "fil";
  return base.replace(/[^\p{L}\p{N}._ -]/gu, "_").slice(0, 120) || "fil";
}
