import type { AppDatabase } from "../db/client";
import { listClassroomAliases } from "../db/queries/classroom-aliases";
import { recordGeneratedImage } from "../db/queries/images";
import { recordUsageEvent } from "../db/queries/usage";
import type { Classroom, GeneratedImage, ModelAlias } from "../db/schema";
import type { GatewayAdapter } from "../gateway/adapter";
import { GatewayError } from "../gateway/errors";
import { extensionFor, type FileStore } from "../storage/files";

/**
 * Image generation: one execution path, two triggers (PRD §15).
 *
 * "Two trigger paths, one execution path. Inside chat, the agent loop exposes an
 * internal generate-image tool… Alongside it, the composer offers an explicit
 * image mode… Both paths converge on the same server-side execution,
 * enforcement, and storage code; the paths differ only in who initiates the
 * call."
 *
 * This module is that convergence. The tool calls it; the composer endpoint
 * calls it; neither reimplements the capability check, the storage, or the
 * debit.
 */

export type ImageRefusal =
  /** No alias in this classroom carries the image-generation flag (§9, §15). */
  | "no-generation-alias"
  /** The named alias is not flagged, or is not this classroom's to use (§15). */
  | "alias-not-capable"
  /** The gateway declined or was unreachable; one message covers all of it (§9). */
  | "unavailable";

export type ImageGenerationResult =
  | { readonly ok: true; readonly image: GeneratedImage; readonly tokensDebited: number }
  | { readonly ok: false; readonly refusal: ImageRefusal };

export interface GenerateImageInput {
  readonly db: AppDatabase;
  readonly adapter: GatewayAdapter;
  readonly files: FileStore;
  readonly classroom: Classroom;
  readonly studentId: string;
  readonly conversationId?: string | null;
  readonly prompt: string;
  /** Chosen by the composer's image mode; the loop lets this module pick (§15). */
  readonly modelAliasId?: string | null;
  readonly signal?: AbortSignal;
}

/**
 * The aliases this classroom may generate images on (§9, §15).
 *
 * Allowlisted *and* available *and* flagged — the same three conditions
 * enforcement applies to text, because §15 says generation is "subject to the
 * same classroom enablement, allowlist, permission, and budget rules as text".
 */
export function generationAliases(db: AppDatabase, classroomId: string): ModelAlias[] {
  return listClassroomAliases(db, classroomId).filter((alias) => alias.supportsImageGeneration);
}

/**
 * Generate one image, store it, and debit the class.
 *
 * The capability check happens first and refuses "before any gateway call"
 * (§15). The debit happens whether or not the student keeps the image: the
 * tokens were spent, and §10's rule that usage is never counted as zero applies
 * here through a fixed equivalent rather than a reported figure.
 */
export async function generateImage(input: GenerateImageInput): Promise<ImageGenerationResult> {
  const { db, classroom } = input;
  const capable = generationAliases(db, classroom.id);

  if (capable.length === 0) return { ok: false, refusal: "no-generation-alias" };

  const alias = input.modelAliasId
    ? capable.find((candidate) => candidate.id === input.modelAliasId)
    : capable[0];

  // An alias the client named that is not allowlisted, not available, or not
  // flagged is refused here — before anything reaches CPA (§15, §21).
  if (!alias) return { ok: false, refusal: "alias-not-capable" };

  let generated: { bytes: Uint8Array; mediaType: string };
  try {
    generated = await input.adapter.generateImage(alias.dialect, {
      model: alias.gatewayModelId,
      prompt: input.prompt,
      signal: input.signal,
    });
  } catch (cause) {
    if (cause instanceof Error && cause.name === "AbortError") throw cause;
    // One student-facing outcome for every gateway failure; the detail stays in
    // the operator log (§9, §21).
    console.warn("image generation failed", {
      classroomId: classroom.id,
      cause: cause instanceof GatewayError ? cause.code : "unknown",
    });
    return { ok: false, refusal: "unavailable" };
  }

  const stored = await input.files.write({
    category: "images",
    ownerId: input.studentId,
    bytes: generated.bytes,
    extension: extensionFor(generated.mediaType),
  });

  const image = recordGeneratedImage(db, {
    studentId: input.studentId,
    conversationId: input.conversationId ?? null,
    prompt: input.prompt,
    mediaType: generated.mediaType,
    storagePath: stored.storagePath,
  });

  // "Each generated image debits a fixed token-equivalent — panel-configurable,
  // default in Appendix A — against the student's daily allowance and the
  // classroom cap, because image endpoints do not reliably report usage and
  // generation must never be free" (§15).
  const tokensDebited = classroom.imageTokenEquivalent;
  recordUsageEvent(db, {
    classroomId: classroom.id,
    studentId: input.studentId,
    modelAliasId: alias.id,
    inputTokens: 0,
    outputTokens: tokensDebited,
    // A policy figure, not a gateway-reported one, and flagged as such (§10).
    estimated: true,
  });

  return { ok: true, image, tokensDebited };
}
