import { fail, redirect } from "@sveltejs/kit";
import * as v from "valibot";
import { requireStudentPage } from "$lib/server/auth/guards";
import { destroySession, SESSION_COOKIE_NAME } from "$lib/server/auth/sessions";
import { getDb } from "$lib/server/boot";
import { classroomAvailability } from "$lib/server/classroom/enforcement";
import { resolveClassroomStatus } from "$lib/server/classroom/status";
import { listClassroomAliases } from "$lib/server/db/queries/classroom-aliases";
import {
  createConversation,
  getOwnedConversation,
  listConversations,
} from "$lib/server/db/queries/conversations";
import { getActivePath } from "$lib/server/db/queries/messages";
import { setStudentInterfaceLanguage } from "$lib/server/db/queries/students";
import { findActiveTurn } from "$lib/server/db/queries/turns";
import { INTERFACE_LANGUAGES } from "$lib/server/db/schema";
import type { Actions, PageServerLoad } from "./$types";

/**
 * The student's own language choice (§8, §18).
 *
 * A one-field form, so a plain progressively-enhanced action — Valibot-validated
 * all the same (§5).
 */
const LanguageSchema = v.object({ language: v.picklist(INTERFACE_LANGUAGES) });

/**
 * The chat route's data (PRD §10).
 *
 * Thin by §6.1: authorise, delegate to the query modules, shape the response.
 * Everything returned is already owner-scoped in SQL.
 *
 * The classroom status travels with the page so a pupil arriving out of hours
 * sees the status screen rather than a composer that will be refused (§8). It is
 * presentation only — the API refuses regardless of what this said.
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

  // A turn still streaming when this tab reloaded: the client resumes it from
  // the buffer rather than losing the answer (§10).
  const activeTurn = findActiveTurn(db, student.id);

  return {
    student: {
      label: student.label,
      displayName: student.displayName,
      interfaceLanguage: student.interfaceLanguage,
    },
    conversations: conversations.map((conversation) => ({
      id: conversation.id,
      title: conversation.title,
    })),
    conversation: active ? { id: active.id, title: active.title } : null,
    messages,
    resumeTurnId: activeTurn?.conversationId === active?.id ? (activeTurn?.id ?? null) : null,
    // Only what this classroom is allowed to use — students never see an alias
    // their educator has not allowlisted (§8, §9).
    hasModel: listClassroomAliases(db, student.classroomId).length > 0,
    status: resolveClassroomStatus(db, student),
  };
};

export const actions: Actions = {
  /** Start a conversation. A form action so it works without JavaScript. */
  create: async ({ locals }) => {
    const student = requireStudentPage(locals);
    const db = getDb();

    // Closed or out-of-hours: redirect lands on the ClassroomClosed screen.
    const availability = classroomAvailability(db, student.classroomId);
    if (!availability?.open) redirect(303, "/chat");

    const alias = listClassroomAliases(db, student.classroomId)[0];
    if (!alias) redirect(303, "/chat");

    const conversation = createConversation(db, {
      studentId: student.id,
      modelAliasId: alias.id,
    });

    redirect(303, `/chat?c=${conversation.id}`);
  },

  /** Override the classroom's interface language for this pupil alone (§8, §18). */
  language: async ({ request, locals }) => {
    const student = requireStudentPage(locals);

    const body = await request.formData();
    const parsed = v.safeParse(LanguageSchema, { language: body.get("language") });
    if (!parsed.success) return fail(400, { invalid: true });

    setStudentInterfaceLanguage(getDb(), {
      studentId: student.id,
      interfaceLanguage: parsed.output.language,
    });

    return { saved: true };
  },

  logout: async ({ locals, cookies }) => {
    if (locals.sessionToken) destroySession(getDb(), locals.sessionToken);
    cookies.delete(SESSION_COOKIE_NAME, { path: "/" });

    redirect(303, "/login");
  },
};
