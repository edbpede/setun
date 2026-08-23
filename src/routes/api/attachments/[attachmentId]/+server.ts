import { error, json } from "@sveltejs/kit";
import { requireStudentApi } from "$lib/server/auth/guards";
import { getDb, getFileStore } from "$lib/server/boot";
import { deleteAttachment, getOwnedAttachment } from "$lib/server/db/queries/attachments";
import { privateFileHeaders } from "$lib/server/storage/serving";
import type { RequestHandler } from "./$types";

/**
 * Serve or discard one attachment (PRD §10, §21).
 *
 * "Stored outside any web root, served only to their owner with restrictive
 * content-type headers, and never served to or from the sandbox origin."
 *
 * The ownership check is the whole authorisation, and it is a query rather than
 * a comparison: another student's attachment is absent, so there is nothing to
 * probe for (§21).
 */
export const GET: RequestHandler = async ({ params, locals }) => {
  const student = requireStudentApi(locals);

  const record = getOwnedAttachment(getDb(), {
    attachmentId: params.attachmentId,
    studentId: student.id,
  });
  if (!record) error(404, "Not found");

  const bytes = await getFileStore().read(record.storagePath);
  if (!bytes) error(404, "Not found");

  return new Response(bytes as BlobPart, {
    headers: privateFileHeaders({ mediaType: record.mediaType, filename: record.filename }),
  });
};

/** Discard an upload the student changed their mind about before sending. */
export const DELETE: RequestHandler = async ({ params, locals }) => {
  const student = requireStudentApi(locals);
  const db = getDb();

  const record = getOwnedAttachment(db, {
    attachmentId: params.attachmentId,
    studentId: student.id,
  });
  if (!record) error(404, "Not found");

  deleteAttachment(db, { attachmentId: record.id, studentId: student.id });
  await getFileStore().remove(record.storagePath);

  return json({ deleted: true });
};
