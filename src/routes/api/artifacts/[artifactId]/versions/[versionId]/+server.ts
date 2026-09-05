import { error, json } from "@sveltejs/kit";
import * as v from "valibot";
import { BUILD_STATUSES } from "$lib/artifacts/types";
import { requireStudentApi } from "$lib/server/auth/guards";
import { getDb } from "$lib/server/boot";
import {
  getOwnedArtifact,
  listArtifactVersions,
  recordVersionBuild,
  snapshotOf,
} from "$lib/server/db/queries/artifacts";
import type { RequestHandler } from "./$types";

/**
 * What happened when the browser ran this revision (PRD §13).
 *
 * The failure a pupil sees used to stop at the panel: the compiler's words were
 * on screen and the model, on the next turn, was told nothing at all — so "it
 * does not work" was the whole of what it had to work from. The browser is the
 * only party that knows whether an artifact ran, so it says so here, and the
 * next turn's prompt states it.
 *
 * Owner-scoped in SQL: another student's artifact is absent rather than
 * forbidden, so there is nothing to probe (§21). Not gated on classroom
 * availability, for the same reason the rest of this route is not — nothing here
 * reaches a model, spends an allowance, or is refused by a locked room (§8).
 */
const BuildSchema = v.object({
  buildStatus: v.picklist(BUILD_STATUSES),
  buildMessage: v.optional(v.nullable(v.pipe(v.string(), v.maxLength(64_000)))),
});

/** The message is a prompt line and a panel line, not a log. */
const MESSAGE_MAX = 2_000;

export const PATCH: RequestHandler = async ({ params, request, locals }) => {
  const student = requireStudentApi(locals);
  const db = getDb();

  const parsed = v.safeParse(BuildSchema, await request.json().catch(() => null));
  if (!parsed.success) error(400, "Invalid request");

  const recorded = recordVersionBuild(db, {
    artifactId: params.artifactId,
    versionId: params.versionId,
    studentId: student.id,
    status: parsed.output.buildStatus,
    message: parsed.output.buildMessage?.slice(0, MESSAGE_MAX) ?? null,
  });

  if (!recorded) error(404, "Not found");

  return json({ ok: true });
};

/**
 * One revision's files, fetched when the pupil selects it (§13).
 *
 * Split off the artifact's own endpoint because a version list is cheap and its
 * sources are not: a project of a hundred kilobytes revised twenty times would
 * otherwise arrive whole every time the History tab opened. That endpoint
 * carries paths, sizes and what each revision changed; this carries the content,
 * for the one revision being read.
 *
 * Owner-scoped through the artifact, and the version has to belong to it: a
 * version identifier from somebody else's artifact is absent rather than
 * forbidden, so there is nothing to probe (§21).
 */
export const GET: RequestHandler = ({ params, locals }) => {
  const student = requireStudentApi(locals);
  const db = getDb();

  const record = getOwnedArtifact(db, { artifactId: params.artifactId, studentId: student.id });
  if (!record) error(404, "Not found");

  const version = listArtifactVersions(db, record.id).find((row) => row.id === params.versionId);
  if (!version) error(404, "Not found");

  const snapshot = snapshotOf(db, version.id);
  if (!snapshot) error(404, "Not found");

  return json({
    id: version.id,
    revision: version.revision,
    entry: snapshot.entry,
    files: snapshot.files,
    source: snapshot.files[snapshot.entry] ?? "",
    language: version.language,
    authoredBy: version.authoredBy,
    buildStatus: version.buildStatus,
    buildMessage: version.buildMessage,
    createdAt: version.createdAt.toISOString(),
  });
};
