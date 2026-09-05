import { fenceFor } from "../../artifacts/fences";
import { fenceInfo } from "../../artifacts/identity";
import { kindOf } from "../../artifacts/project";
import type { MessagePart } from "../db/schema";

/**
 * The block a student's edited artifact travels in (PRD §13).
 *
 * "When an artifact has been edited since the model last emitted it, the next
 * message in that conversation carries the current source, clearly marked as the
 * student's edited version — so 'I broke it, help me fix it' works without
 * pasting code by hand."
 *
 * Lifted out of the agent loop, which is where it used to sit as a private
 * function: a project is several fences now rather than one, and the encoding is
 * a thing about artifacts rather than a thing about loops.
 *
 * The marker is addressed to the model, so it is not a Paraglide message. It
 * says outright what to do with the block, because a pupil's edited page that
 * comes back under `id=home-page` is answerable with the same fences under the
 * same id, which is the whole mechanism.
 */
export function encodeArtifactEdit(part: Extract<MessagePart, { type: "artifact-edit" }>): string {
  const named = part.title
    ? ` ${JSON.stringify(part.title.replace(/\s+/g, " ").trim().slice(0, 120))}`
    : "";
  const key = part.key ?? null;
  const files = filesOf(part);
  const deleted = part.deleted ?? [];
  const multiFile = files.length > 1 || deleted.length > 0;

  const header = [
    "",
    "",
    `[The student's edited version of the ${part.language} artifact${named}.`,
    "This is the current source, not the version you last wrote.",
    ...(key
      ? [
          multiFile
            ? `Only the files they changed are shown. To change it, reuse id=${key} with the same paths.]`
            : `To change it, reuse id=${key} and write the complete file.]`,
        ]
      : ["]"]),
  ];

  return [
    ...header,
    ...files.flatMap(([path, source]) => encodeFile(part, path, source, multiFile)),
    ...deleted.flatMap((path) => encodeDeletion(part, path)),
  ].join("\n");
}

/**
 * Which files the block states.
 *
 * A part written before projects carries only `source`, and encodes as the one
 * file it always was — under no path, because the model was never told one.
 */
function filesOf(part: Extract<MessagePart, { type: "artifact-edit" }>): [string, string][] {
  if (part.files) return Object.entries(part.files);
  return [["", part.source]];
}

function encodeFile(
  part: Extract<MessagePart, { type: "artifact-edit" }>,
  path: string,
  source: string,
  multiFile: boolean,
): string[] {
  const key = part.key ?? null;
  // The tag the file's own extension implies, so a stylesheet arrives as `css`
  // rather than as the artifact's language.
  const tag = (path ? kindOf(path) : null) ?? part.language;

  const info =
    key !== null
      ? fenceInfo(tag, {
          key,
          path: path || null,
          // The name belongs on the file that *is* the artifact, not on its
          // stylesheet.
          title: path === "" || path === part.entry ? part.title : null,
          // Only where it settles something: a one-file block is unambiguous,
          // and `entry` on every fence of every message is noise the model has
          // to read past.
          entry: multiFile && path === part.entry,
        })
      : part.language;

  // Long enough for this source: a page that explains markdown holds a line of
  // three backticks, which would close a three-backtick fence early and send the
  // rest of the pupil's file to the model as prose.
  const fence = fenceFor(source);

  return [`${fence}${info}`, source, fence];
}

/** A file the student removed: an empty fence carrying the `delete` flag (§13). */
function encodeDeletion(
  part: Extract<MessagePart, { type: "artifact-edit" }>,
  path: string,
): string[] {
  const tag = kindOf(path) ?? part.language;
  const info = fenceInfo(tag, { key: part.key ?? null, path, entry: false });

  const fence = "```";
  return [`${fence}${info} delete`, fence];
}
