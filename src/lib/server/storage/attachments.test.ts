import { describe, expect, it } from "bun:test";
import { resolveAttachmentPolicy } from "../classroom/settings";
import type { Classroom, ModelAlias, Student } from "../db/schema";
import {
  type AttachmentPolicy,
  inlineTextAttachment,
  sniffMediaType,
  validateAttachment,
} from "./attachments";

/**
 * Attachment validation (plan 3.11, PRD §10, §21, §22).
 *
 * §22 names attachment validation in `bun test` and "attachment type and size
 * enforcement" as security coverage. The matrix below is that enforcement: the
 * declared type is never consulted, the caps are the classroom's, and an image
 * on a non-capable alias is refused before anything could reach a gateway.
 */

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0, 0]);
const TEXT = new TextEncoder().encode("const answer = 42;\n");
const BINARY = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0xff, 0xfe]);

const POLICY: AttachmentPolicy = {
  enabled: true,
  allowedTypes: ["image/png", "image/jpeg", "image/webp", "text/plain"],
  imageMaxBytes: 5 * 1024 * 1024,
  textMaxBytes: 256 * 1024,
  maxPerMessage: 5,
  aliasSupportsImageInput: true,
};

function check(bytes: Uint8Array, overrides: Partial<AttachmentPolicy> = {}, existingCount = 0) {
  return validateAttachment({
    bytes,
    policy: { ...POLICY, ...overrides },
    existingCount,
  });
}

describe("content sniffing", () => {
  it("recognises the image types Appendix A allows by default", () => {
    expect(sniffMediaType(PNG)).toBe("image/png");
    expect(sniffMediaType(JPEG)).toBe("image/jpeg");
    expect(sniffMediaType(WEBP)).toBe("image/webp");
  });

  it("reads anything that decodes as UTF-8 without a NUL as text", () => {
    expect(sniffMediaType(TEXT)).toBe("text/plain");
    expect(sniffMediaType(new TextEncoder().encode("æøå — Danish"))).toBe("text/plain");
  });

  it("recognises nothing in bytes that are neither", () => {
    expect(sniffMediaType(BINARY)).toBeNull();
    expect(sniffMediaType(new Uint8Array())).toBeNull();
  });

  it("does not consult what the uploader claimed (§21)", () => {
    // A PNG renamed and re-declared as text is still a PNG, and a classroom
    // whose allowlist excludes images refuses it on that basis.
    const result = check(PNG, { allowedTypes: ["text/plain"] });
    expect(result).toEqual({ ok: false, refusal: "type-not-allowed" });
  });
});

describe("the validation matrix (§10, §22)", () => {
  it("accepts an allowed image within the cap", () => {
    expect(check(PNG)).toEqual({ ok: true, kind: "image", mediaType: "image/png" });
  });

  it("accepts an allowed text file within the cap", () => {
    expect(check(TEXT)).toEqual({ ok: true, kind: "text", mediaType: "text/plain" });
  });

  it("refuses a type outside the educator's allowlist", () => {
    expect(check(WEBP, { allowedTypes: ["image/png"] })).toEqual({
      ok: false,
      refusal: "type-not-allowed",
    });
  });

  it("refuses a type nothing recognises", () => {
    expect(check(BINARY)).toEqual({ ok: false, refusal: "type-not-allowed" });
  });

  it("refuses an image over the classroom's image cap", () => {
    expect(check(PNG, { imageMaxBytes: 4 })).toEqual({ ok: false, refusal: "too-large" });
  });

  it("refuses a text file over the classroom's text cap", () => {
    expect(check(TEXT, { textMaxBytes: 4 })).toEqual({ ok: false, refusal: "too-large" });
  });

  it("applies the two caps independently", () => {
    // A text file smaller than the image cap is still measured against its own.
    expect(check(TEXT, { textMaxBytes: 4, imageMaxBytes: 5_000_000 })).toEqual({
      ok: false,
      refusal: "too-large",
    });
  });

  it("refuses more than the per-message limit", () => {
    expect(check(PNG, {}, 5)).toEqual({ ok: false, refusal: "too-many" });
    expect(check(PNG, { maxPerMessage: 1 }, 1)).toEqual({ ok: false, refusal: "too-many" });
  });

  it("refuses everything when the classroom has attachments switched off", () => {
    expect(check(PNG, { enabled: false })).toEqual({
      ok: false,
      refusal: "attachments-disabled",
    });
    expect(check(TEXT, { enabled: false })).toEqual({
      ok: false,
      refusal: "attachments-disabled",
    });
  });

  it("refuses an image on an alias without the image-input flag, before any gateway call (§10)", () => {
    expect(check(PNG, { aliasSupportsImageInput: false })).toEqual({
      ok: false,
      refusal: "image-input-not-supported",
    });
    // A text file on the same alias is unaffected: it is inlined, not forwarded.
    expect(check(TEXT, { aliasSupportsImageInput: false }).ok).toBe(true);
  });

  it("refuses an empty file", () => {
    expect(check(new Uint8Array())).toEqual({ ok: false, refusal: "empty" });
  });
});

describe("policy resolution (§2, §10)", () => {
  const classroom = {
    attachmentsEnabled: true,
    attachmentTypes: ["image/png"],
    attachmentImageMaxBytes: 1000,
    attachmentTextMaxBytes: 100,
    attachmentMaxPerMessage: 3,
  } as Classroom;

  const alias = { supportsImageInput: true } as ModelAlias;

  it("follows the classroom when the student carries no override", () => {
    const policy = resolveAttachmentPolicy(
      classroom,
      { attachmentsEnabled: null } as Student,
      alias,
    );
    expect(policy.enabled).toBe(true);
    expect(policy.maxPerMessage).toBe(3);
  });

  it("lets a per-student override switch attachments off for one pupil", () => {
    const policy = resolveAttachmentPolicy(
      classroom,
      { attachmentsEnabled: false } as Student,
      alias,
    );
    expect(policy.enabled).toBe(false);
  });

  it("lets a per-student override switch them on where the class has them off", () => {
    const policy = resolveAttachmentPolicy(
      { ...classroom, attachmentsEnabled: false } as Classroom,
      { attachmentsEnabled: true } as Student,
      alias,
    );
    expect(policy.enabled).toBe(true);
  });

  it("takes the image-input capability from the conversation's alias (§9)", () => {
    const policy = resolveAttachmentPolicy(
      classroom,
      { attachmentsEnabled: null } as Student,
      { supportsImageInput: false } as ModelAlias,
    );
    expect(policy.aliasSupportsImageInput).toBe(false);
  });
});

describe("inlining text attachments (§10)", () => {
  it("labels the file and fences its content", () => {
    const inlined = inlineTextAttachment("svar.py", new TextEncoder().encode("print(42)"));
    expect(inlined).toContain("svar.py:");
    expect(inlined).toContain("```\nprint(42)\n```");
  });

  it("lengthens the fence so a file full of backticks cannot break out", () => {
    const inlined = inlineTextAttachment(
      "readme.md",
      new TextEncoder().encode("```js\nconsole.log(1)\n```"),
    );
    expect(inlined).toContain("````");
    // The whole file survives inside one fence.
    expect(inlined).toContain("console.log(1)");
  });
});
