import { error, json } from "@sveltejs/kit";
import * as v from "valibot";
import { defaultPathFor, runnableLanguageOf } from "$lib/artifacts/project";
import { ARTIFACT_LANGUAGES } from "$lib/artifacts/types";
import { requireStudentApi } from "$lib/server/auth/guards";
import { getDb } from "$lib/server/boot";
import {
  appendSnapshot,
  getOwnedArtifact,
  latestSnapshotOf,
} from "$lib/server/db/queries/artifacts";
import type { RequestHandler } from "./$types";

/**
 * Store the student's edit as a new revision (PRD §13).
 *
 * "Students edit artifact source in CodeMirror; edits recompile locally with no
 * model request." Compilation happens in the sandbox; this is only the record of
 * it — no gateway call, no allowance spent, no availability check, because
 * nothing on this path can reach a model (§8, §13).
 *
 * Revisions are appended, never rewritten: "every version is retained", which is
 * what makes undo and the diff view possible at all.
 */
const VersionSchema = v.object({
  source: v.pipe(v.string(), v.maxLength(256_000)),
  /**
   * The tag this revision is written under (§13).
   *
   * Optional, because a plain edit is written under whatever the artifact says.
   * A Restore is the case that needs it: an html revision of an artifact since
   * rewritten as a component comes back as html, and running it through the
   * Svelte compiler is not a lesson about anything.
   */
  language: v.optional(v.picklist(ARTIFACT_LANGUAGES)),
});

export const POST: RequestHandler = async ({ params, request, locals }) => {
  const student = requireStudentApi(locals);
  const db = getDb();

  const parsed = v.safeParse(VersionSchema, await request.json().catch(() => null));
  if (!parsed.success) error(400, "Invalid request");

  const record = getOwnedArtifact(db, { artifactId: params.artifactId, studentId: student.id });
  if (!record) error(404, "Not found");

  /**
   * Where the edited file lands (§13).
   *
   * An edit keeps the path the revision it was made against used. A Restore
   * under a different tag is the exception: an html revision of an artifact
   * since rewritten as a component comes back as `index.html`, not as the
   * `App.svelte` the current revision holds.
   */
  const previous = latestSnapshotOf(db, record.id);
  const language = parsed.output.language ?? record.language;
  const entry =
    previous && runnableLanguageOf(previous.entry) === language
      ? previous.entry
      : defaultPathFor(language);

  const files: Record<string, string> = { ...(previous?.files ?? {}) };
  if (previous && entry !== previous.entry) delete files[previous.entry];
  files[entry] = parsed.output.source;

  const version = appendSnapshot(db, {
    artifactId: record.id,
    entry,
    files,
    language: parsed.output.language ?? null,
    authoredBy: "student",
  });

  return json(
    {
      id: version.id,
      revision: version.revision,
      entry: version.entryPath,
      source: parsed.output.source,
      language: version.language,
      authoredBy: version.authoredBy,
      buildStatus: version.buildStatus,
      buildMessage: version.buildMessage,
      createdAt: version.createdAt.toISOString(),
    },
    { status: 201 },
  );
};
