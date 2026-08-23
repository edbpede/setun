import { and, desc, eq } from "drizzle-orm";
import type { AppDatabase } from "../client";
import { type GeneratedImage, generatedImage } from "../schema";

/**
 * Generated image records (PRD §15, §16, §19).
 *
 * Every read is owner-scoped: an image is served "only by Setun to their owner",
 * and a query that could answer without a student id would be the hole (§21).
 */

export function recordGeneratedImage(
  db: AppDatabase,
  input: {
    studentId: string;
    conversationId?: string | null;
    messageId?: string | null;
    prompt: string;
    mediaType: string;
    storagePath: string;
  },
): GeneratedImage {
  return db
    .insert(generatedImage)
    .values({
      studentId: input.studentId,
      conversationId: input.conversationId ?? null,
      messageId: input.messageId ?? null,
      prompt: input.prompt,
      mediaType: input.mediaType,
      storagePath: input.storagePath,
    })
    .returning()
    .get();
}

/** One image, for its owner. Absent rather than forbidden for anyone else (§21). */
export function getOwnedImage(
  db: AppDatabase,
  input: { imageId: string; studentId: string },
): GeneratedImage | undefined {
  return db
    .select()
    .from(generatedImage)
    .where(and(eq(generatedImage.id, input.imageId), eq(generatedImage.studentId, input.studentId)))
    .get();
}

/** The student's own gallery, newest first (§16, §18). */
export function listStudentImages(db: AppDatabase, studentId: string): GeneratedImage[] {
  return db
    .select()
    .from(generatedImage)
    .where(eq(generatedImage.studentId, studentId))
    .orderBy(desc(generatedImage.createdAt))
    .all();
}

export function attachImageToMessage(
  db: AppDatabase,
  input: { imageId: string; messageId: string },
): void {
  db.update(generatedImage)
    .set({ messageId: input.messageId })
    .where(eq(generatedImage.id, input.imageId))
    .run();
}
