import { fail, redirect } from "@sveltejs/kit";
import * as v from "valibot";
import { generationAliases } from "$lib/server/agent/image-generation";
import { requireStudentPage } from "$lib/server/auth/guards";
import { destroySession, SESSION_COOKIE_NAME } from "$lib/server/auth/sessions";
import { getDb } from "$lib/server/boot";
import { classroomAvailability } from "$lib/server/classroom/enforcement";
import { resolveClassroomStatus } from "$lib/server/classroom/status";
import { getConfig } from "$lib/server/config";
import { listConversationArtifacts } from "$lib/server/db/queries/artifacts";
import { listPendingAttachments } from "$lib/server/db/queries/attachments";
import { listClassroomAliases } from "$lib/server/db/queries/classroom-aliases";
import { getClassroom } from "$lib/server/db/queries/classrooms";
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

  // The parts travel whole: tool calls, generated images and attachments are as
  // much of the transcript as the prose is, and the same component renders a
  // reloaded message and a streaming one (§10, §11, §15).
  const messages = active?.activeLeafId
    ? getActivePath(db, active.activeLeafId).map((message) => ({
        id: message.id,
        role: message.role,
        parts: message.parts,
      }))
    : [];

  // A turn still streaming when this tab reloaded: the client resumes it from
  // the buffer rather than losing the answer (§10).
  const activeTurn = findActiveTurn(db, student.id);
  const classroom = getClassroom(db, student.classroomId);

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
    // Presentation only: the upload endpoint refuses on its own policy read, and
    // hiding a control is never access control (§8, §10, §21).
    attachmentsEnabled: student.attachmentsEnabled ?? classroom?.attachmentsEnabled ?? false,
    imageModeAvailable: generationAliases(db, student.classroomId).length > 0,
    // Uploads the pupil made before this reload; the composer shows them again.
    pendingAttachments: active
      ? listPendingAttachments(db, { studentId: student.id, conversationId: active.id }).map(
          (file) => ({
            id: file.id,
            filename: file.filename,
            kind: file.kind,
            mediaType: file.mediaType,
            byteSize: file.byteSize,
          }),
        )
      : [],
    status: resolveClassroomStatus(db, student),
    // Artifacts this conversation produced, each with the revision on screen.
    // Creations outlive conversations, so the gallery reads them separately (§16).
    artifacts: active
      ? listConversationArtifacts(db, {
          conversationId: active.id,
          studentId: student.id,
        }).map(({ artifact, latest }) => ({
          id: artifact.id,
          language: artifact.language,
          title: artifact.title,
          latest: {
            id: latest.id,
            revision: latest.revision,
            source: latest.source,
            authoredBy: latest.authoredBy,
            createdAt: latest.createdAt.toISOString(),
          },
        }))
      : [],
    // A distinct hostname, and the only other thing Caddy exposes: artifacts are
    // isolated by origin, not by path (§6, §14). Public, not a secret.
    sandboxOrigin: getConfig().sandboxOrigin,
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
