import { error, json } from "@sveltejs/kit";
import * as v from "valibot";
import {
  asProjectFiles,
  entryOf,
  PROJECT_FILE_MAX_BYTES,
  PROJECT_MAX_FILES,
} from "$lib/artifacts/project";
import { ARTIFACT_LANGUAGES } from "$lib/artifacts/types";
import { requireStudentApi } from "$lib/server/auth/guards";
import { getDb } from "$lib/server/boot";
import {
  appendSnapshot,
  getOwnedArtifact,
  latestSnapshotOf,
  listArtifactVersions,
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
 *
 * The body states a *change* to the project rather than the whole of it: a pupil
 * editing one file of five posts one file, and the other four are carried
 * forward from the revision beneath. `replace` is the exception, and is what a
 * Restore sends — a stored revision can hold files the current one does not.
 */
const VersionSchema = v.object({
  /** Path → source, for the files this revision states. Validated by `asProjectFiles`. */
  files: v.record(v.string(), v.pipe(v.string(), v.maxLength(PROJECT_FILE_MAX_BYTES))),
  /** Paths this revision removes from the project. */
  deletes: v.optional(v.array(v.pipe(v.string(), v.maxLength(200))), []),
  /**
   * Whether `files` is the whole project rather than a change to it.
   *
   * A Restore, which brings back a revision that may lack files the current one
   * holds — merging those would leave a project that is neither revision.
   */
  replace: v.optional(v.boolean(), false),
  /**
   * The tag this revision is written under (§13).
   *
   * Optional, because a plain edit is written under whatever the artifact says.
   * A Restore is the case that needs it: an html revision of an artifact since
   * rewritten as a component comes back as html, and running it through the
   * Svelte compiler is not a lesson about anything.
   */
  language: v.optional(v.picklist(ARTIFACT_LANGUAGES)),
  /** Which file runs, where the caller knows; otherwise it is resolved. */
  entry: v.optional(v.string()),
});

export const POST: RequestHandler = async ({ params, request, locals }) => {
  const student = requireStudentApi(locals);
  const db = getDb();

  const parsed = v.safeParse(VersionSchema, await request.json().catch(() => null));
  if (!parsed.success) error(400, "Invalid request");

  const record = getOwnedArtifact(db, { artifactId: params.artifactId, studentId: student.id });
  if (!record) error(404, "Not found");

  const body = parsed.output;
  const previous = latestSnapshotOf(db, record.id);

  const composed: Record<string, string> = body.replace ? {} : { ...(previous?.files ?? {}) };
  for (const [path, source] of Object.entries(body.files)) composed[path] = source;
  for (const path of body.deletes) delete composed[path];

  if (Object.keys(composed).length > PROJECT_MAX_FILES) error(400, "Invalid request");

  // The one gate: a path that would leave the project, or a payload that would
  // fill the database, is refused here rather than stored (§21).
  const files = asProjectFiles(composed);
  if (!files) error(400, "Invalid request");

  const entry = entryOf(files, {
    explicit: body.entry ?? null,
    previous: body.replace ? null : (previous?.entry ?? null),
  });
  if (!entry) error(400, "Invalid request");

  /**
   * A no-op is not a revision.
   *
   * The panel's debounced idle fires on a pupil who typed and undid, and a
   * history of identical revisions is a history of nothing. Answering with the
   * revision that already holds it keeps the client's copy in step.
   */
  const unchanged =
    previous !== null &&
    previous.entry === entry &&
    Object.keys(previous.files).length === Object.keys(files).length &&
    Object.entries(files).every(([path, source]) => previous.files[path] === source);

  const version = unchanged
    ? listArtifactVersions(db, record.id).at(-1)
    : appendSnapshot(db, {
        artifactId: record.id,
        entry,
        files,
        language: body.language ?? null,
        authoredBy: "student",
      });

  if (!version) error(404, "Not found");

  return json(
    {
      id: version.id,
      revision: version.revision,
      entry,
      files,
      source: files[entry] ?? "",
      language: version.language,
      authoredBy: version.authoredBy,
      buildStatus: version.buildStatus,
      buildMessage: version.buildMessage,
      createdAt: version.createdAt.toISOString(),
    },
    { status: unchanged ? 200 : 201 },
  );
};
