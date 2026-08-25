import { json } from "@sveltejs/kit";
import * as v from "valibot";
import { requireStudentApi } from "$lib/server/auth/guards";
import { getDb } from "$lib/server/boot";
import { searchConversations } from "$lib/server/db/queries/search";
import type { RequestHandler } from "./$types";

/**
 * Search this student's own conversations (PRD §10, §18, §21).
 *
 * Thin by §6.1: authorise, validate, delegate, shape. The owner comes from the
 * resolved session and never from the request — there is no parameter here that
 * could name somebody else's conversations, which is what makes the §22
 * cross-student search test pass by construction rather than by a filter.
 */

const QuerySchema = v.object({
  q: v.pipe(v.string(), v.trim(), v.maxLength(200)),
});

export const GET: RequestHandler = ({ locals, url }) => {
  const student = requireStudentApi(locals);

  const parsed = v.safeParse(QuerySchema, { q: url.searchParams.get("q") ?? "" });
  // A malformed query is an empty result, not an error: this is a search box,
  // and a pupil typing quickly should not see a failure.
  if (!parsed.success) return json({ hits: [] });

  return json({
    hits: searchConversations(getDb(), {
      studentId: student.id,
      query: parsed.output.q,
    }).map((hit) => ({
      conversationId: hit.conversationId,
      title: hit.title,
      excerpt: hit.excerpt,
      updatedAt: hit.updatedAt.toISOString(),
    })),
  });
};
