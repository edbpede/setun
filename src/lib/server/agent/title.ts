import type { AppDatabase } from "../db/client";
import { setConversationTitle } from "../db/queries/conversations";
import { getUtilityAlias } from "../db/queries/model-aliases";
import { classroomDailyConsumption, recordUsageEvent } from "../db/queries/usage";
import type { Classroom } from "../db/schema";
import type { GatewayAdapter } from "../gateway/adapter";
import { budgetDayRange, budgetsOf, mayRunUtilityWork } from "./budgets";

/**
 * Conversation titles (PRD §10).
 *
 * "Conversation titles are generated asynchronously by the utility alias after
 * the first exchange, falling back to a truncation of the first user message."
 *
 * Utility work counts toward the per-classroom daily cap but never a student's
 * personal allowance, so its usage event records a null student — and when that
 * cap is exhausted the work is skipped and the fallback used (§10).
 */

const MAX_TITLE_LENGTH = 60;

const TITLE_INSTRUCTION = [
  "Write a short title for a conversation that begins with the message below.",
  "Five words at most. No quotation marks, no trailing punctuation, no preamble.",
  "Reply with the title only, in the same language as the message.",
].join(" ");

/**
 * Truncate a first message into a title.
 *
 * Always available and never fails, which is what makes it the fallback for
 * every path below: no utility alias configured, a gateway failure, or an empty
 * answer.
 */
export function fallbackTitle(firstMessage: string): string {
  const collapsed = firstMessage.replace(/\s+/g, " ").trim();
  if (collapsed.length <= MAX_TITLE_LENGTH) return collapsed;

  const truncated = collapsed.slice(0, MAX_TITLE_LENGTH);
  const lastSpace = truncated.lastIndexOf(" ");
  // Cut at a word boundary when there is a reasonable one.
  return `${lastSpace > MAX_TITLE_LENGTH / 2 ? truncated.slice(0, lastSpace) : truncated}…`;
}

function tidy(raw: string): string {
  const cleaned = raw
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["'«»„“]+|["'«»„“.]+$/g, "")
    .trim();
  return cleaned.length > MAX_TITLE_LENGTH ? fallbackTitle(cleaned) : cleaned;
}

/**
 * Generate and store a title, falling back on any failure.
 *
 * Runs detached from the student's turn: a title is a convenience, and nothing
 * about it may delay or break the conversation it names.
 */
export async function generateConversationTitle(input: {
  db: AppDatabase;
  adapter: GatewayAdapter;
  conversationId: string;
  studentId: string;
  classroom: Classroom;
  firstMessage: string;
  now?: Date;
}): Promise<string> {
  const { db, classroom } = input;
  const now = input.now ?? new Date();
  const fallback = fallbackTitle(input.firstMessage);
  const utility = getUtilityAlias(db);

  // "When the classroom cap is exhausted, utility work is skipped and its
  // fallback used" (§10) — a title is never worth the last of a class's day.
  const range = budgetDayRange(classroom.timezone, now);
  const classroomTokens = classroomDailyConsumption(db, {
    classroomId: classroom.id,
    from: range.start,
    until: range.end,
  });
  const affordable = mayRunUtilityWork(budgetsOf(classroom), { classroomTokens });

  if (!utility?.available || !affordable) {
    setConversationTitle(db, {
      conversationId: input.conversationId,
      studentId: input.studentId,
      title: fallback,
    });
    return fallback;
  }

  let generated = "";
  try {
    for await (const event of input.adapter.streamChat(utility.dialect, {
      model: utility.gatewayModelId,
      messages: [
        { role: "system", content: TITLE_INSTRUCTION },
        { role: "user", content: input.firstMessage.slice(0, 2_000) },
      ],
    })) {
      if (event.type === "text-delta") generated += event.text;
      if (event.type === "usage") {
        // Null student: the classroom cap only, never a personal allowance (§10).
        recordUsageEvent(db, {
          classroomId: classroom.id,
          studentId: null,
          modelAliasId: utility.id,
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
          estimated: event.estimated,
        });
      }
    }
  } catch {
    // Any gateway failure falls back silently; the student never learns that a
    // title call happened at all (§9, §21).
    generated = "";
  }

  const title = tidy(generated) || fallback;
  setConversationTitle(db, {
    conversationId: input.conversationId,
    studentId: input.studentId,
    title,
  });
  return title;
}
