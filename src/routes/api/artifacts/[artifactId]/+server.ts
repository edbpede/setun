import { error, json } from "@sveltejs/kit";
import { requireStudentApi } from "$lib/server/auth/guards";
import { getDb } from "$lib/server/boot";
import { getOwnedArtifact, listArtifactVersions } from "$lib/server/db/queries/artifacts";
import type { RequestHandler } from "./$types";

/**
 * One artifact with its ordered revisions (PRD §13, §19).
 *
 * The history behind the diff view and the undo. Owner-scoped in SQL: another
 * student's artifact is absent rather than forbidden, so there is nothing to
 * probe (§21).
 *
 * Not gated on classroom availability. Nothing here can reach a model, and the
 * gallery is the student's portfolio — a locked room must not lock a pupil out
 * of what they already made (§8, §16).
 */
export const GET: RequestHandler = ({ params, locals }) => {
  const student = requireStudentApi(locals);
  const db = getDb();

  const record = getOwnedArtifact(db, { artifactId: params.artifactId, studentId: student.id });
  if (!record) error(404, "Not found");

  return json({
    id: record.id,
    language: record.language,
    title: record.title,
    versions: listArtifactVersions(db, record.id).map((version) => ({
      id: version.id,
      revision: version.revision,
      source: version.source,
      authoredBy: version.authoredBy,
      createdAt: version.createdAt.toISOString(),
    })),
  });
};
