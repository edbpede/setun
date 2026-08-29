import { resolveStudentSettings } from "../classroom/settings";
import type { AppDatabase } from "../db/client";
import { listAttachmentsByIds } from "../db/queries/attachments";
import type { Classroom, Message, MessagePart, Student } from "../db/schema";
import type { GatewayAdapter } from "../gateway/adapter";
import type { McpClient } from "../mcp/client";
import { resolveSkills, skillIndexEntries } from "../skills/registry";
import { type AttachmentPayload, loadAttachmentPayloads } from "../storage/attachments";
import type { FileStore } from "../storage/files";
import type { SystemPromptLayers } from "./system-prompt";
import { buildToolSet, type ToolContext, type ToolSet } from "./tools";

/**
 * Everything a turn needs, assembled once (PRD §10, §11, §12).
 *
 * The send endpoint stays thin by §6.1 — parse, authorise, delegate, shape —
 * and "delegate" is this. It also puts the three resolutions in one place, which
 * matters because they have to agree: the skills in the prompt index are the
 * skills the loader will accept, and the tools offered to the model are the
 * tools the loop will execute.
 */

export interface PreparedTurn {
  readonly tools: ToolSet;
  readonly toolContext: ToolContext;
  readonly promptLayers: SystemPromptLayers;
  readonly attachmentPayloads: ReadonlyMap<string, AttachmentPayload>;
}

export async function prepareTurn(input: {
  db: AppDatabase;
  adapter: GatewayAdapter;
  files: FileStore;
  mcp: McpClient | null;
  classroom: Classroom;
  student: Student;
  conversationId: string;
  path: readonly Pick<Message, "role" | "parts">[];
}): Promise<PreparedTurn> {
  const settings = resolveStudentSettings(input.classroom, input.student);

  const skills = resolveSkills(input.db, {
    classroomId: input.classroom.id,
    studentId: input.student.id,
    authoringPolicy: input.classroom.skillAuthoringPolicy,
  });

  const toolContext: ToolContext = {
    db: input.db,
    adapter: input.adapter,
    files: input.files,
    mcp: input.mcp,
    classroom: input.classroom,
    studentId: input.student.id,
    conversationId: input.conversationId,
    skills,
  };

  const attachmentIds = input.path.flatMap((message) =>
    message.parts
      .filter(
        (part): part is Extract<MessagePart, { type: "attachment" }> => part.type === "attachment",
      )
      .map((part) => part.attachmentId),
  );

  const attachmentPayloads = await loadAttachmentPayloads(
    input.files,
    listAttachmentsByIds(input.db, { attachmentIds, studentId: input.student.id }),
  );

  return {
    tools: buildToolSet(toolContext),
    toolContext,
    promptLayers: {
      classroomInstructions: settings.classroomInstructions,
      studentInstructions: settings.studentInstructions,
      // Appended last, by §10; the loader tool below it reads the same list.
      skillIndex: skillIndexEntries(skills),
    },
    attachmentPayloads,
  };
}
