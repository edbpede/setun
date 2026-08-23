import DOMPurify from "dompurify";
import { marked } from "marked";

/**
 * Markdown rendering for model output (PRD §5, §20).
 *
 * "Model output is untrusted HTML source; sanitisation is mandatory, not
 * optional." So `marked` output never reaches the DOM without passing through
 * DOMPurify, and the two are bound together in this one function rather than
 * left as two steps a caller could perform separately — or forget to.
 *
 * Sanitisation runs in the browser because DOMPurify needs a DOM. Streaming
 * text is rendered as plain preformatted text and only becomes markdown once the
 * turn settles, so there is no server-rendered path for unsanitised model HTML
 * to take (§20).
 */

marked.setOptions({
  // Newlines are line breaks: a model writing prose does not double-space.
  breaks: true,
  gfm: true,
});

/**
 * Elements and attributes the renderer permits.
 *
 * An allowlist rather than DOMPurify's defaults: the defaults are broad enough
 * to include form and media elements that have no business in a chat message.
 */
const ALLOWED_TAGS = [
  "p",
  "br",
  "hr",
  "strong",
  "em",
  "del",
  "code",
  "pre",
  "blockquote",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "ul",
  "ol",
  "li",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
  "a",
  "span",
];

const ALLOWED_ATTR = ["href", "title", "class", "lang"];

/**
 * Render markdown to sanitised HTML.
 *
 * Returns a string destined for `{@html}` — which is safe here precisely
 * because this function is the only producer of such strings, and it never
 * returns unsanitised output on any path.
 */
export function renderMarkdown(source: string): string {
  const html = marked.parse(source, { async: false });

  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    // Rejects `javascript:` and `data:` URLs; only these three schemes survive.
    ALLOWED_URI_REGEXP: /^(?:https?|mailto):/i,
    // No <template>, no shadow content, no SVG or MathML namespaces.
    USE_PROFILES: { html: true },
  });
}

/**
 * Whether the text has an unclosed fenced code block.
 *
 * Highlighting runs only once a fence closes; while one is open the block stays
 * plain preformatted text, because re-highlighting a growing block on every
 * delta is exactly the work the target Chromebook cannot spare (§20).
 */
export function hasOpenFence(source: string): boolean {
  let open = false;
  for (const line of source.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) open = !open;
  }
  return open;
}
