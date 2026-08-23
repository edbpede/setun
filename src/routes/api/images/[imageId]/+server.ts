import { error } from "@sveltejs/kit";
import { requireStudentApi } from "$lib/server/auth/guards";
import { getDb, getFileStore } from "$lib/server/boot";
import { getOwnedImage } from "$lib/server/db/queries/images";
import { privateFileHeaders } from "$lib/server/storage/serving";
import type { RequestHandler } from "./$types";

/**
 * Serve one generated image (PRD §15, §21).
 *
 * "Generated images are stored locally and served from Setun; no external image
 * URL is ever handed to the browser." This is the only way a browser reaches
 * one, and it is owner-scoped in SQL.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
  const student = requireStudentApi(locals);

  const record = getOwnedImage(getDb(), { imageId: params.imageId, studentId: student.id });
  if (!record) error(404, "Not found");

  const bytes = await getFileStore().read(record.storagePath);
  if (!bytes) error(404, "Not found");

  return new Response(bytes as BlobPart, {
    headers: privateFileHeaders({ mediaType: record.mediaType }),
  });
};
