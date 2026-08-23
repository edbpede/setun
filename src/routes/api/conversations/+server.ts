import { error, json } from "@sveltejs/kit";
import * as v from "valibot";
import { requireStudentApi } from "$lib/server/auth/guards";
import { getDb } from "$lib/server/boot";
import { createConversation, listConversations } from "$lib/server/db/queries/conversations";
import { getAliasById, listAvailableAliases } from "$lib/server/db/queries/model-aliases";
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

  // An explicit alias must be one that exists and is available; otherwise take
  // the first available one. Phase 2.6 narrows this to the classroom allowlist.
  const alias = parsed.output.modelAliasId
    ? getAliasById(db, parsed.output.modelAliasId)
    : listAvailableAliases(db)[0];

  if (!alias?.available) error(409, "Model unavailable");

  const conversation = createConversation(db, {
    studentId: student.id,
    modelAliasId: alias.id,
  });

  return json({ id: conversation.id }, { status: 201 });
};
