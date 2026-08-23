import { unlink } from "node:fs/promises";
import { join, normalize } from "node:path";

/**
 * The local file store (PRD §15, §16, §21).
 *
 * "Uploads are… stored outside any web root, served only to their owner with
 * restrictive content-type headers, and never served to or from the sandbox
 * origin." Generated images live under the same rule: "no external image URL is
 * ever handed to the browser" (§15).
 *
 * Nothing serves this directory. Every read goes through an owner-scoped
 * endpoint, and the only way to name a file is to hold the database row that
 * points at it — which is itself owner-scoped.
 */

export type StorageCategory = "attachments" | "images";

/**
 * A stored path, as written to the database.
 *
 * `<category>/<ownerId>/<uuid>.<extension>`, and nothing else is accepted back:
 * a row whose path does not match this shape is refused rather than resolved,
 * so a path that somehow acquired a `..` cannot reach outside the root.
 */
const STORAGE_PATH = /^(attachments|images)\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.[a-z0-9]{1,8}$/;

export class FileStore {
  readonly #root: string;

  constructor(root: string) {
    this.#root = root;
  }

  /** Write bytes and return the path recorded on the row that owns them. */
  async write(input: {
    category: StorageCategory;
    ownerId: string;
    bytes: Uint8Array;
    extension: string;
  }): Promise<{ storagePath: string; byteSize: number }> {
    const storagePath = `${input.category}/${input.ownerId}/${crypto.randomUUID()}.${input.extension}`;
    await Bun.write(this.#absolute(storagePath), input.bytes);
    return { storagePath, byteSize: input.bytes.byteLength };
  }

  /** Read a stored file, or null when it is gone — a deleted file is not an error. */
  async read(storagePath: string): Promise<Uint8Array | null> {
    const file = Bun.file(this.#absolute(storagePath));
    if (!(await file.exists())) return null;
    return new Uint8Array(await file.arrayBuffer());
  }

  /** Delete a stored file; a file already gone is success, not a failure. */
  async remove(storagePath: string): Promise<void> {
    await unlink(this.#absolute(storagePath)).catch(() => {});
  }

  #absolute(storagePath: string): string {
    if (!STORAGE_PATH.test(storagePath)) {
      throw new Error("refusing a storage path that is not of the stored form");
    }
    // Belt and braces: the pattern above already excludes `..`, and normalising
    // means a future change to the pattern cannot quietly reintroduce it.
    return join(this.#root, normalize(storagePath));
  }
}

/** The extension a stored file gets, from its sniffed type. */
export function extensionFor(mediaType: string): string {
  switch (mediaType) {
    case "image/png":
      return "png";
    case "image/jpeg":
      return "jpg";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    default:
      return "bin";
  }
}
