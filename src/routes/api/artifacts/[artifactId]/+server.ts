import { error, json } from "@sveltejs/kit";
import { effectiveArtifactKey } from "$lib/artifacts/identity";
import { requireStudentApi } from "$lib/server/auth/guards";
import { getDb } from "$lib/server/boot";
import {
  getOwnedArtifact,
  listArtifactVersions,
  snapshotsOf,
} from "$lib/server/db/queries/artifacts";
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

  const versions = listArtifactVersions(db, record.id);
  const snapshots = snapshotsOf(
    db,
    versions.map((version) => version.id),
  );

  return json({
    id: record.id,
    language: record.language,
    title: record.title,
    // The id the model reuses to change it — derived when the row stores none,
    // so every artifact answers to a key whether or not it was given one (§13).
    key: effectiveArtifactKey(record),
    versions: versions.map((version) => ({
      id: version.id,
      revision: version.revision,
      entry: version.entryPath,
      source: snapshots.get(version.id)?.files[version.entryPath] ?? "",
      // Null for a revision written before the column, which reads as "whatever
      // the artifact says" — `effectiveLanguage` is the one that resolves it.
      language: version.language,
      authoredBy: version.authoredBy,
      buildStatus: version.buildStatus,
      buildMessage: version.buildMessage,
      createdAt: version.createdAt.toISOString(),
    })),
  });
};
