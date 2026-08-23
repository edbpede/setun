import { error, json } from "@sveltejs/kit";
import * as v from "valibot";
import { generateImage } from "$lib/server/agent/image-generation";
import { requireStudentApi } from "$lib/server/auth/guards";
import { getDb, getFileStore, getGatewayAdapter } from "$lib/server/boot";
import { checkModelAccess } from "$lib/server/classroom/enforcement";
import { classroomStateChannel } from "$lib/server/classroom/state-channel";
import { getOwnedConversation, setActiveLeaf } from "$lib/server/db/queries/conversations";
import { attachImageToMessage } from "$lib/server/db/queries/images";
import { appendMessage } from "$lib/server/db/queries/messages";
import type { RequestHandler } from "./$types";

/**
 * The composer's explicit image mode (PRD §15).
 *
 * "Two trigger paths, one execution path… Both paths converge on the same
 * server-side execution, enforcement, and storage code; the paths differ only in
 * who initiates the call."
 *
 * This is the second trigger. It reaches the same `generateImage`, past the same
 * enforcement guard every path that can reach a model passes (§8, §21) — the
 * only difference from the agent-loop path is that a student asked directly
 * rather than a model asking on their behalf.
 */

const GenerateSchema = v.object({
  conversationId: v.pipe(v.string(), v.uuid()),
  prompt: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(2_000)),
  /** Which generation-capable alias to use; the server refuses any other (§15). */
  modelAliasId: v.optional(v.pipe(v.string(), v.uuid())),
});

export const POST: RequestHandler = async ({ request, locals }) => {
  const student = requireStudentApi(locals);
  const db = getDb();

  const parsed = v.safeParse(GenerateSchema, await request.json().catch(() => null));
  if (!parsed.success) error(400, "Invalid request");

  const { conversationId, prompt, modelAliasId } = parsed.output;

  const conversation = getOwnedConversation(db, { conversationId, studentId: student.id });
  if (!conversation) error(404, "Not found");

  // Availability, the classroom allowlist and the daily budgets, in one guard —
  // against the alias generation will actually run on, not the conversation's.
  const access = checkModelAccess({
    db,
    student,
    modelAliasId: modelAliasId ?? conversation.modelAliasId,
  });

  if (!access.allowed) {
    return json(
      {
        error: access.reason,
        nextOpeningAt: access.availability.nextOpeningAt?.toISOString() ?? null,
      },
      { status: 403 },
    );
  }

  const result = await generateImage({
    db,
    adapter: getGatewayAdapter(),
    files: getFileStore(),
    classroom: access.classroom,
    studentId: student.id,
    conversationId,
    prompt,
    modelAliasId,
  });

  if (!result.ok) return json({ error: result.refusal }, { status: 422 });

  // The exchange joins the transcript, so the picture and what was asked for
  // stay together in the conversation as well as in the gallery (§13, §16).
  const promptMessage = appendMessage(db, {
    conversationId,
    parentId: conversation.activeLeafId ?? null,
    role: "user",
    parts: [{ type: "text", text: prompt }],
  });

  const imageMessage = appendMessage(db, {
    conversationId,
    parentId: promptMessage.id,
    role: "assistant",
    parts: [{ type: "generated-image", imageId: result.image.id, prompt }],
  });

  attachImageToMessage(db, { imageId: result.image.id, messageId: imageMessage.id });
  setActiveLeaf(db, { conversationId, studentId: student.id, messageId: imageMessage.id });

  // The allowance just moved by the fixed token-equivalent (§15).
  classroomStateChannel.publish(student.classroomId);

  return json({ imageId: result.image.id, tokensDebited: result.tokensDebited }, { status: 201 });
};
