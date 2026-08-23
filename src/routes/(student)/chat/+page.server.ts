import { redirect } from "@sveltejs/kit";
import { requireStudentPage } from "$lib/server/auth/guards";
import { destroySession, SESSION_COOKIE_NAME } from "$lib/server/auth/sessions";
import { getDb } from "$lib/server/boot";
import {
  createConversation,
  getOwnedConversation,
  listConversations,
} from "$lib/server/db/queries/conversations";
import { getActivePath } from "$lib/server/db/queries/messages";
import { listAvailableAliases } from "$lib/server/db/queries/model-aliases";
import { findActiveTurn } from "$lib/server/db/queries/turns";
import type { Actions, PageServerLoad } from "./$types";

/**
 * The chat route's data (PRD §10).
 *
 * Thin by §6.1: authorise, delegate to the query modules, shape the response.
 * Everything returned is already owner-scoped in SQL.
 */
export const load: PageServerLoad = ({ locals, url }) => {
  const student = requireStudentPage(locals);
  const db = getDb();

  const conversations = listConversations(db, student.id);
  const requestedId = url.searchParams.get("c");

  const active = requestedId
    ? getOwnedConversation(db, { conversationId: requestedId, studentId: student.id })
    : conversations[0];

  const messages = active?.activeLeafId
    ? getActivePath(db, active.activeLeafId).map((message) => ({
        id: message.id,
        role: message.role,
        text: message.parts
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join(""),
      }))
    : [];

  // A turn still streaming when the tab reloaded: the client resumes it from
  // the buffer rather than losing the answer (§10).
  const activeTurn = findActiveTurn(db, student.id);

  return {
    student: { label: student.label, displayName: student.displayName },
    conversations: conversations.map((conversation) => ({
      id: conversation.id,
      title: conversation.title,
    })),
    conversation: active ? { id: active.id, title: active.title } : null,
    messages,
    resumeTurnId: activeTurn?.conversationId === active?.id ? (activeTurn?.id ?? null) : null,
    hasModel: listAvailableAliases(db).length > 0,
  };
};

export const actions: Actions = {
  /** Start a conversation. A form action so it works without JavaScript. */
  create: async ({ locals }) => {
    const student = requireStudentPage(locals);
    const db = getDb();

    const alias = listAvailableAliases(db)[0];
    if (!alias) redirect(303, "/chat");

    const conversation = createConversation(db, {
      studentId: student.id,
      modelAliasId: alias.id,
    });

    redirect(303, `/chat?c=${conversation.id}`);
  },

  logout: async ({ locals, cookies }) => {
    if (locals.sessionToken) destroySession(getDb(), locals.sessionToken);
    cookies.delete(SESSION_COOKIE_NAME, { path: "/" });

    redirect(303, "/login");
  },
};
