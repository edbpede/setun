import { error, json } from "@sveltejs/kit";
import * as v from "valibot";
import { assertNoTurnInFlight, TurnInFlightError } from "$lib/server/agent/concurrency";
import { executeTurn } from "$lib/server/agent/runner";
import { sseResponse, TURN_ID_HEADER } from "$lib/server/agent/sse-response";
import { streamTurnEvents } from "$lib/server/agent/stream";
import { generateConversationTitle } from "$lib/server/agent/title";
import { requireStudentApi } from "$lib/server/auth/guards";
import { getDb, getGatewayAdapter } from "$lib/server/boot";
import { getOwnedConversation, setActiveLeaf } from "$lib/server/db/queries/conversations";
import { appendMessage, appendSibling, getActivePath } from "$lib/server/db/queries/messages";
import { getAliasById } from "$lib/server/db/queries/model-aliases";
import { createTurn } from "$lib/server/db/queries/turns";
import type { RequestHandler } from "./$types";

/**
 * Send a message and stream the answer (PRD §10).
 *
 * Thin by §6.1: parse, authorise, delegate to `$lib/server/agent`, shape the
 * response. The turn runs detached from this request, so the same
 * `streamTurnEvents` serves this response and a later resume — one code path.
 */

const SendSchema = v.object({
  conversationId: v.pipe(v.string(), v.uuid()),
  text: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(32_000)),
  /**
   * Present when editing an existing prompt: the new text is appended as a
   * sibling of that message rather than as a child of the active leaf (§10).
   */
  editOfMessageId: v.optional(v.pipe(v.string(), v.uuid())),
});

export const POST: RequestHandler = async ({ request, locals }) => {
  const student = requireStudentApi(locals);
  const db = getDb();

  const parsed = v.safeParse(SendSchema, await request.json().catch(() => null));
  if (!parsed.success) error(400, "Invalid request");

  const { conversationId, text, editOfMessageId } = parsed.output;

  // Ownership resolved in SQL: another student's conversation is simply absent (§21).
  const conversation = getOwnedConversation(db, { conversationId, studentId: student.id });
  if (!conversation) error(404, "Not found");

  const alias = getAliasById(db, conversation.modelAliasId);
  if (!alias?.available) error(409, "Model unavailable");

  // One turn in flight per student, across all of their conversations (§10).
  try {
    assertNoTurnInFlight(db, student.id);
  } catch (cause) {
    if (cause instanceof TurnInFlightError) {
      return json({ error: "turn-in-flight", activeTurnId: cause.activeTurnId }, { status: 409 });
    }
    throw cause;
  }

  const prompt = editOfMessageId
    ? appendSibling(db, {
        siblingOfId: editOfMessageId,
        role: "user",
        parts: [{ type: "text", text }],
      })
    : appendMessage(db, {
        conversationId,
        parentId: conversation.activeLeafId ?? null,
        role: "user",
        parts: [{ type: "text", text }],
      });

  if (!prompt) error(404, "Not found");

  setActiveLeaf(db, { conversationId, studentId: student.id, messageId: prompt.id });

  const turn = createTurn(db, {
    conversationId,
    studentId: student.id,
    parentMessageId: prompt.id,
  });

  // Detached on purpose: a closed tab must not cancel the turn, because the
  // student can resume it (§10).
  void executeTurn({
    db,
    adapter: getGatewayAdapter(),
    turnId: turn.id,
    conversationId,
    studentId: student.id,
    classroomId: student.classroomId,
    alias,
    parentMessageId: prompt.id,
    path: getActivePath(db, prompt.id),
  });

  // Titles are generated after the first exchange, asynchronously, and never
  // block or break the turn they name (§10).
  if (!conversation.title) {
    void generateConversationTitle({
      db,
      adapter: getGatewayAdapter(),
      conversationId,
      studentId: student.id,
      classroomId: student.classroomId,
      firstMessage: text,
    });
  }

  return sseResponse(streamTurnEvents(db, turn.id), {
    headers: { [TURN_ID_HEADER]: turn.id },
  });
};
