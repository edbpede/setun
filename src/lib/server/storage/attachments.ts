import type { AttachmentKind } from "../db/schema";

/**
 * Attachment validation (PRD §10, §21).
 *
 * "Uploads are validated server-side — content sniffing against the allowlist,
 * size limits — stored locally… and deleted with their conversation."
 *
 * Sniffing rather than trusting: the browser's declared type is a claim by the
 * party being validated, so it is used only to reject early. What is stored, and
 * what any later request serves, is the type the bytes actually are.
 */

/** Every way an upload can be refused, each with a friendly message above (§10). */
export type AttachmentRefusal =
  | "attachments-disabled"
  | "type-not-allowed"
  | "too-large"
  | "too-many"
  | "image-input-not-supported"
  | "empty";

export interface AttachmentPolicy {
  readonly enabled: boolean;
  readonly allowedTypes: readonly string[];
  readonly imageMaxBytes: number;
  readonly textMaxBytes: number;
  readonly maxPerMessage: number;
  /** The conversation's alias carries the image-input capability flag (§9, §10). */
  readonly aliasSupportsImageInput: boolean;
}

export type AttachmentValidation =
  | { readonly ok: true; readonly kind: AttachmentKind; readonly mediaType: string }
  | { readonly ok: false; readonly refusal: AttachmentRefusal };

/**
 * Magic-byte signatures for the image types Appendix A allows by default.
 *
 * Deliberately short: an allowlist of four signatures cannot be talked into
 * recognising a fifth format, which is the property that matters here.
 */
const SIGNATURES: readonly { mediaType: string; test: (bytes: Uint8Array) => boolean }[] = [
  {
    mediaType: "image/png",
    test: (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  },
  {
    mediaType: "image/jpeg",
    test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    mediaType: "image/webp",
    test: (b) =>
      b.length > 12 &&
      b[0] === 0x52 &&
      b[1] === 0x49 &&
      b[2] === 0x46 &&
      b[3] === 0x46 &&
      b[8] === 0x57 &&
      b[9] === 0x45 &&
      b[10] === 0x42 &&
      b[11] === 0x50,
  },
  {
    mediaType: "image/gif",
    test: (b) => b.length > 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46,
  },
];

/**
 * What these bytes actually are.
 *
 * Anything that is not a recognised image and decodes as UTF-8 without a NUL is
 * text — which is how a `.svelte`, `.py` or `.csv` file arrives, none of which
 * has a signature to match (§10: "plain text or code files").
 */
export function sniffMediaType(bytes: Uint8Array): string | null {
  if (bytes.byteLength === 0) return null;

  for (const signature of SIGNATURES) {
    if (signature.test(bytes)) return signature.mediaType;
  }

  return isProbablyText(bytes) ? "text/plain" : null;
}

function isProbablyText(bytes: Uint8Array): boolean {
  // A NUL byte anywhere is the clearest single signal that this is not text,
  // and it is checked before decoding because decoding a large binary is waste.
  const sample = bytes.subarray(0, 8192);
  if (sample.includes(0)) return false;

  try {
    new TextDecoder("utf-8", { fatal: true }).decode(sample);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate one upload against the classroom's policy.
 *
 * Order matters: the cheapest refusals come first, and the image-capability
 * check comes before anything that would reach a gateway — "attaching an image
 * on a non-capable alias is refused with a friendly message before any gateway
 * call" (§10).
 */
export function validateAttachment(input: {
  bytes: Uint8Array;
  policy: AttachmentPolicy;
  existingCount: number;
}): AttachmentValidation {
  const { policy } = input;

  if (!policy.enabled) return refuse("attachments-disabled");
  if (input.existingCount >= policy.maxPerMessage) return refuse("too-many");
  if (input.bytes.byteLength === 0) return refuse("empty");

  const mediaType = sniffMediaType(input.bytes);
  if (!mediaType || !policy.allowedTypes.includes(mediaType)) return refuse("type-not-allowed");

  const kind: AttachmentKind = mediaType.startsWith("image/") ? "image" : "text";

  if (kind === "image" && !policy.aliasSupportsImageInput) {
    return refuse("image-input-not-supported");
  }

  const cap = kind === "image" ? policy.imageMaxBytes : policy.textMaxBytes;
  if (input.bytes.byteLength > cap) return refuse("too-large");

  return { ok: true, kind, mediaType };
}

function refuse(refusal: AttachmentRefusal): AttachmentValidation {
  return { ok: false, refusal };
}

/**
 * A text attachment's content, ready to be inlined into the message (§10).
 *
 * "Text/code files inlined as text" — fenced and labelled so the model can tell
 * the student's file from the student's prose, and so a file containing
 * backticks cannot break out of the fence.
 */
export function inlineTextAttachment(filename: string, bytes: Uint8Array): string {
  const text = new TextDecoder().decode(bytes);
  const fence = "`".repeat(Math.max(3, longestBacktickRun(text) + 1));
  return `${filename}:\n${fence}\n${text}\n${fence}`;
}

function longestBacktickRun(text: string): number {
  let longest = 0;
  for (const run of text.matchAll(/`+/g)) longest = Math.max(longest, run[0].length);
  return longest;
}

/**
 * What a stored attachment contributes to the model input (§10).
 *
 * An image travels inline as base64; a text/code file travels as the fenced
 * text the loop appends to the message. Both are read from storage here so the
 * loop stays pure over stored parts and the filesystem stays out of every
 * termination-condition test.
 */
export type AttachmentPayload =
  | { readonly kind: "image"; readonly mediaType: string; readonly data: string }
  | { readonly kind: "text"; readonly text: string };

/**
 * Read the attachments on a message path, ready for the gateway (§10).
 *
 * Text and code files are stored already fenced (see the upload handler), so
 * for them the stored bytes are the exact text the model should read — decode
 * and pass through. Images are base64-encoded. Either way a file that has gone
 * is simply not sent: the message still makes sense without it, and failing the
 * turn over a missing attachment would not.
 */
export async function loadAttachmentPayloads(
  files: { read(storagePath: string): Promise<Uint8Array | null> },
  attachments: readonly {
    id: string;
    kind: AttachmentKind;
    mediaType: string;
    storagePath: string;
  }[],
): Promise<Map<string, AttachmentPayload>> {
  const payloads = new Map<string, AttachmentPayload>();

  for (const record of attachments) {
    const bytes = await files.read(record.storagePath);
    if (!bytes) continue;

    if (record.kind === "image") {
      payloads.set(record.id, {
        kind: "image",
        mediaType: record.mediaType,
        data: encodeBase64(bytes),
      });
    } else if (record.kind === "text") {
      payloads.set(record.id, { kind: "text", text: new TextDecoder().decode(bytes) });
    }
    // A kind neither of those is not silently mangled — it is simply not sent,
    // the same as a missing file. A new binary kind must add its own branch
    // rather than being UTF-8-decoded here by accident.
  }

  return payloads;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
