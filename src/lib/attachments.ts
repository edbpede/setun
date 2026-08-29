/**
 * Every media type the attachment sniffer can produce (PRD §10).
 *
 * Outside `$lib/server` because the educator's allowlist control renders one
 * checkbox per entry, and a client component may not import a server module —
 * the schema column that is typed by this list imports it from here instead.
 *
 * The educator's control is bounded by this rather than by free text: a type
 * `sniffMediaType` cannot return is an allowlist entry that never matches, which
 * is a control that decides nothing. Adding a format means adding a signature in
 * `$lib/server/storage/attachments.ts`, and this list follows from it.
 */
export const ATTACHMENT_MEDIA_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "text/plain",
] as const;

export type AttachmentMediaType = (typeof ATTACHMENT_MEDIA_TYPES)[number];
