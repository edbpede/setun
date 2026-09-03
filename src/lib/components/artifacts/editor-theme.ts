import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { tags } from "@lezer/highlight";

/**
 * How CodeMirror is dressed, in both themes (PRD §13, §20).
 *
 * CodeMirror ships two sets of colours and picks between them from its own
 * `darkTheme` facet, which is fixed when a view is constructed. The interface
 * theme is not: a pupil can switch it while an editor is open, and rebuilding
 * the view would throw away their cursor, their selection and their undo
 * history to repaint a gutter.
 *
 * So neither set is used. Every colour here resolves through a CSS custom
 * property, which the browser re-evaluates at paint — the editor follows the
 * document's theme with no reconstruction and no listener. `app.css` holds the
 * two palettes.
 *
 * Those `--code-*` variables are complete colours, unlike the `--primary`-style
 * theme tokens, which are bare oklch components because `unocss-preset-shadcn`'s
 * own utilities supply the wrapper. Nothing wraps a value in a CodeMirror theme
 * spec, so these carry their own `oklch()`.
 *
 * Loaded with the rest of CodeMirror, on demand: the chat route has a 250 KB
 * gzipped budget and most lessons never open an editor at all (§20).
 */

/** The chrome: gutters, cursor, selection, active line. */
export const editorChrome: Extension = EditorView.theme({
  "&": {
    height: "100%",
    fontSize: "13px",
    backgroundColor: "transparent",
    color: "oklch(var(--foreground))",
  },
  ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.6" },
  ".cm-content": { caretColor: "oklch(var(--foreground))" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "oklch(var(--foreground))" },
  ".cm-gutters": {
    backgroundColor: "transparent",
    color: "oklch(var(--muted-foreground))",
    border: "0",
    borderRight: "1px solid oklch(var(--border))",
  },
  ".cm-activeLine": { backgroundColor: "oklch(var(--muted))" },
  ".cm-activeLineGutter": {
    backgroundColor: "oklch(var(--muted))",
    color: "oklch(var(--foreground))",
  },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, .cm-content ::selection": {
    backgroundColor: "oklch(var(--accent))",
  },
  ".cm-foldPlaceholder": {
    backgroundColor: "oklch(var(--secondary))",
    color: "oklch(var(--secondary-foreground))",
    border: "1px solid oklch(var(--border))",
  },
});

/**
 * The grammar colours.
 *
 * Registered as a real highlighter rather than left to `@codemirror/language`'s
 * light-tuned fallback, which is unreadable the moment the page is dark.
 */
export const editorHighlight: Extension = syntaxHighlighting(
  HighlightStyle.define([
    {
      tag: [tags.keyword, tags.controlKeyword, tags.operatorKeyword],
      color: "var(--code-keyword)",
    },
    {
      tag: [tags.string, tags.special(tags.string), tags.attributeValue],
      color: "var(--code-string)",
    },
    {
      tag: [tags.comment, tags.lineComment, tags.blockComment],
      color: "var(--code-comment)",
      fontStyle: "italic",
    },
    { tag: [tags.number, tags.bool, tags.null, tags.atom], color: "var(--code-number)" },
    {
      tag: [tags.typeName, tags.tagName, tags.className, tags.namespace],
      color: "var(--code-type)",
    },
    { tag: [tags.propertyName, tags.attributeName, tags.labelName], color: "var(--code-property)" },
    {
      tag: [tags.function(tags.variableName), tags.definition(tags.variableName)],
      color: "var(--code-function)",
    },
    {
      tag: [tags.operator, tags.punctuation, tags.bracket, tags.angleBracket, tags.separator],
      color: "var(--code-operator)",
    },
    { tag: [tags.meta, tags.processingInstruction], color: "var(--code-comment)" },
    { tag: tags.link, color: "var(--code-property)", textDecoration: "underline" },
    { tag: tags.strong, fontWeight: "600" },
    { tag: tags.emphasis, fontStyle: "italic" },
    { tag: tags.invalid, color: "var(--code-invalid)" },
  ]),
);

/**
 * What the unified diff paints over that (§13).
 *
 * `@codemirror/merge` carries the same two fixed palettes as the base theme, and
 * the same objection applies — so its surfaces are restated here through the
 * variables instead.
 *
 * Each class is written twice. Upstream's rules live in a *base* theme, where
 * `&light` and `&dark` are legal and expand to a class of their own, so they
 * carry one more class than the obvious override would — and `&light` is not
 * accepted in an ordinary theme, so it cannot simply be repeated. Doubling the
 * class raises the specificity instead, which wins without depending on the
 * order two style modules happen to be mounted in.
 *
 * A changed *run* inside a changed line keeps upstream's device — a two-pixel
 * bar under the text rather than a second fill — because it reads as "this bit
 * moved" without asking anyone to tell two tints apart.
 */
export const diffTheme: Extension = EditorView.theme({
  "&.cm-merge-b .cm-changedLine.cm-changedLine, & .cm-inlineChangedLine.cm-inlineChangedLine": {
    backgroundColor: "var(--code-added-surface)",
  },
  "&.cm-merge-a .cm-changedLine.cm-changedLine, & .cm-deletedChunk.cm-deletedChunk": {
    backgroundColor: "var(--code-removed-surface)",
    color: "oklch(var(--foreground))",
  },
  "&.cm-merge-b .cm-changedText.cm-changedText": {
    background: "linear-gradient(var(--code-added), var(--code-added)) bottom/100% 2px no-repeat",
  },
  [[
    "&.cm-merge-a .cm-changedText.cm-changedText",
    "& .cm-deletedChunk .cm-deletedText.cm-deletedText",
  ].join(", ")]: {
    background:
      "linear-gradient(var(--code-removed), var(--code-removed)) bottom/100% 2px no-repeat",
  },
  "&.cm-merge-b .cm-deletedText.cm-deletedText": {
    backgroundColor: "var(--code-removed-surface)",
  },
  "&.cm-merge-b .cm-changedLineGutter.cm-changedLineGutter": {
    background: "var(--code-added)",
  },
  [[
    "&.cm-merge-a .cm-changedLineGutter.cm-changedLineGutter",
    "& .cm-deletedLineGutter.cm-deletedLineGutter",
  ].join(", ")]: { background: "var(--code-removed)" },
});
