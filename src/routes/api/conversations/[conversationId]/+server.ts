import { error, json } from "@sveltejs/kit";
import { requireStudentApi } from "$lib/server/auth/guards";
import { getDb } from "$lib/server/boot";
import { deleteConversation } from "$lib/server/db/queries/conversations";
import type { RequestHandler } from "./$types";

/**
 * A single conversation (PRD §10, §16).
 *
 * Deletion is owner-scoped in SQL and cascades to messages, turns and buffered
 * events through the schema — a student deleting their conversation deletes
 * everything it carried (§16).
 */
export const DELETE: RequestHandler = ({ params, locals }) => {
  const student = requireStudentApi(locals);

  const deleted = deleteConversation(getDb(), {
    conversationId: params.conversationId,
    studentId: student.id,
  });

  // Absent and not-yours are the same answer, so neither can be probed (§21).
  if (!deleted) error(404, "Not found");

  return json({ deleted: true });
};
