/**
 * Headers for the files Setun serves back (PRD §14, §21).
 *
 * "Served only to their owner with restrictive content-type headers, and never
 * served to or from the sandbox origin."
 *
 * The owner check happens in the endpoint; what happens here is everything that
 * makes the response itself safe — the browser must not sniff a different type
 * out of the bytes, must not execute anything the file contains, and must not
 * let another origin read it.
 */
export function privateFileHeaders(input: {
  mediaType: string;
  filename?: string;
}): Record<string, string> {
  return {
    // The sniffed type, never the uploader's claim (§21).
    "content-type": input.mediaType,
    // Without this a browser may decide a text file is HTML and run it.
    "x-content-type-options": "nosniff",
    // Nothing in a served file may load or execute anything at all.
    "content-security-policy": "default-src 'none'; sandbox",
    // The sandbox origin is a different origin, so this is what stops it
    // reading an attachment even with a session cookie present (§14, §21).
    "cross-origin-resource-policy": "same-origin",
    // Owner-scoped content must never be held by a shared cache.
    "cache-control": "private, no-store",
    ...(input.filename
      ? { "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(input.filename)}` }
      : {}),
  };
}
