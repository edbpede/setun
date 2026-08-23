import { error, json } from "@sveltejs/kit";
import * as v from "valibot";
import { requireStudentApi } from "$lib/server/auth/guards";
import { getDb } from "$lib/server/boot";
import { isAliasAllowed, listClassroomAliases } from "$lib/server/db/queries/classroom-aliases";
import { createConversation, listConversations } from "$lib/server/db/queries/conversations";
import type { RequestHandler } from "./$types";

/**
 * Conversation collection (PRD §10).
 *
 * Thin by §6.1: parse, authorise, delegate to the query modules, shape the
 * response. Listing is owner-scoped in SQL, so a student can only ever see
 * their own (§21).
 */

const CreateSchema = v.object({
  modelAliasId: v.optional(v.pipe(v.string(), v.uuid())),
});

export const GET: RequestHandler = ({ locals }) => {
  const student = requireStudentApi(locals);

  const conversations = listConversations(getDb(), student.id).map((conversation) => ({
    id: conversation.id,
    title: conversation.title,
    updatedAt: conversation.updatedAt.toISOString(),
  }));

  return json({ conversations });
};

export const POST: RequestHandler = async ({ request, locals }) => {
  const student = requireStudentApi(locals);
  const db = getDb();

  const parsed = v.safeParse(CreateSchema, await request.json().catch(() => ({})));
  if (!parsed.success) error(400, "Invalid request");

  // Only aliases the educator allowlisted for this classroom, and only ones
  // still in service. An absent row is a denial, so a client naming any other
  // alias is refused rather than quietly given a different model (§8, §9, §21).
  const classroomId = student.classroomId;
  const requested = parsed.output.modelAliasId;

  if (requested && !isAliasAllowed(db, { classroomId, modelAliasId: requested })) {
    error(409, "Model unavailable");
  }

  const modelAliasId = requested ?? listClassroomAliases(db, classroomId)[0]?.id;
  if (!modelAliasId) error(409, "Model unavailable");

  const conversation = createConversation(db, { studentId: student.id, modelAliasId });

  return json({ id: conversation.id }, { status: 201 });
};
