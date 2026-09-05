import { error, json } from "@sveltejs/kit";
import { effectiveArtifactKey } from "$lib/artifacts/identity";
import { diffFileLists } from "$lib/artifacts/project";
import { requireStudentApi } from "$lib/server/auth/guards";
import { getDb } from "$lib/server/boot";
import {
  getOwnedArtifact,
  listArtifactVersions,
  listVersionFiles,
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
  /**
   * The files of every revision, without their content (§13).
   *
   * A version list is cheap and its sources are not — a project revised twenty
   * times would otherwise arrive whole every time the History tab opened. What
   * each revision *did* is computed here from the hashes, which is what the list
   * shows; the content is fetched for the one revision the pupil selects.
   */
  const byVersion = new Map<string, { path: string; hash: string; bytes: number }[]>();
  for (const file of listVersionFiles(
    db,
    versions.map((version) => version.id),
  )) {
    byVersion.set(file.versionId, [...(byVersion.get(file.versionId) ?? []), file]);
  }

  return json({
    id: record.id,
    language: record.language,
    title: record.title,
    // The id the model reuses to change it — derived when the row stores none,
    // so every artifact answers to a key whether or not it was given one (§13).
    key: effectiveArtifactKey(record),
    versions: versions.map((version, at) => {
      const files = byVersion.get(version.id) ?? [];
      const previous = at === 0 ? [] : (byVersion.get(versions[at - 1].id) ?? []);
      const changes = diffFileLists(previous, files);
      const sizes = new Map([...previous, ...files].map((file) => [file.path, file.bytes]));

      return {
        id: version.id,
        revision: version.revision,
        entry: version.entryPath,
        files: changes.map(({ path, change }) => ({
          path,
          bytes: sizes.get(path) ?? 0,
          change,
        })),
        // Null for a revision written before the column, which reads as "whatever
        // the artifact says" — `effectiveLanguage` is the one that resolves it.
        language: version.language,
        authoredBy: version.authoredBy,
        buildStatus: version.buildStatus,
        buildMessage: version.buildMessage,
        createdAt: version.createdAt.toISOString(),
      };
    }),
  });
};
