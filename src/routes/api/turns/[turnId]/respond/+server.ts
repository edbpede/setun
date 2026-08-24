import { error, json } from "@sveltejs/kit";
import * as v from "valibot";
import { turnInteractions } from "$lib/server/agent/interactions";
import { requireStudentApi } from "$lib/server/auth/guards";
import { getDb } from "$lib/server/boot";
import { getOwnedTurn, isTerminal } from "$lib/server/db/queries/turns";
import type { RequestHandler } from "./$types";

/**
 * Answer a question the running turn asked (PRD §11).
 *
 * A permission request and an elicitation both pause the loop and wait for the
 * student. The loop runs detached from the request that started it, so the
 * answer arrives here and is handed to the waiting turn by identifier.
 *
 * Thin by §6.1: parse, authorise, delegate. The ownership check is the whole
 * authorisation — a turn belonging to another student is absent, so nobody can
 * approve a tool call on someone else's behalf (§21).
 */

/**
 * The flat primitives §11 allows, and nothing richer.
 *
 * Validated here as well as normalised at the transport edge, because this is a
 * public endpoint and the shape a client sends is not evidence of anything.
 */
const ElicitationValue = v.union([v.pipe(v.string(), v.maxLength(4_000)), v.number(), v.boolean()]);

const RespondSchema = v.union([
  v.object({
    requestId: v.string(),
    kind: v.literal("permission"),
    approved: v.boolean(),
  }),
  v.object({
    requestId: v.string(),
    kind: v.literal("elicitation"),
    declined: v.optional(v.boolean(), false),
    values: v.optional(v.record(v.pipe(v.string(), v.maxLength(120)), ElicitationValue), {}),
  }),
]);

export const POST: RequestHandler = async ({ params, request, locals }) => {
  const student = requireStudentApi(locals);
  const db = getDb();

  const parsed = v.safeParse(RespondSchema, await request.json().catch(() => null));
  if (!parsed.success) error(400, "Invalid request");

  const turn = getOwnedTurn(db, { turnId: params.turnId, studentId: student.id });
  if (!turn) error(404, "Not found");

  // A turn that already ended has nothing waiting; answering it is a late click
  // rather than an error worth showing anyone.
  if (isTerminal(turn.status)) return json({ delivered: false });

  const answer = parsed.output;
  const delivered = turnInteractions.answer({
    turnId: turn.id,
    requestId: answer.requestId,
    answer:
      answer.kind === "permission"
        ? { kind: "permission", approved: answer.approved }
        : { kind: "elicitation", values: answer.values, declined: answer.declined },
  });

  return json({ delivered });
};
