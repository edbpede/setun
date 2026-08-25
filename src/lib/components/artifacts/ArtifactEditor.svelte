<script lang="ts">
import type { EditorView } from "@codemirror/view";
import type { Attachment } from "svelte/attachments";
import type { ArtifactLanguage } from "$lib/artifacts/types";
import * as m from "$lib/paraglide/messages";

/**
 * The artifact source editor (PRD §13, §20).
 *
 * "Students edit artifact source in CodeMirror; edits recompile locally with no
 * model request." Nothing here compiles — a keystroke reports upwards and stops
 * there; the panel decides when a commit point has been reached (§13).
 *
 * CodeMirror is loaded on demand rather than imported at the top of the module:
 * the chat route has a 250 KB gzipped budget and most lessons never open an
 * editor at all (§20).
 */

interface Props {
  value: string;
  language: ArtifactLanguage;
  onchange: (source: string) => void;
}

let { value, language, onchange }: Props = $props();

let view = $state<EditorView | null>(null);

/** The grammar CodeMirror highlights with; markup languages share the HTML mode. */
async function languageSupport(kind: ArtifactLanguage) {
  if (kind === "jsx" || kind === "tsx") {
    const { javascript } = await import("@codemirror/lang-javascript");
    return javascript({ jsx: true, typescript: kind === "tsx" });
  }

  const { html } = await import("@codemirror/lang-html");
  return html();
}

const editor: Attachment<HTMLDivElement> = (node) => {
  let disposed = false;

  void (async () => {
    const [
      { EditorView: View, keymap, lineNumbers, highlightActiveLineGutter },
      state,
      commands,
      support,
    ] = await Promise.all([
      import("@codemirror/view"),
      import("@codemirror/state"),
      import("@codemirror/commands"),
      languageSupport(language),
    ]);

    if (disposed) return;

    const created = new View({
      parent: node,
      state: state.EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          commands.history(),
          keymap.of([...commands.defaultKeymap, ...commands.historyKeymap]),
          View.lineWrapping,
          // The editable element is what a screen reader lands on, so the label
          // belongs there rather than on the wrapper.
          View.contentAttributes.of({ "aria-label": m.artifact_editor_label() }),
          support,
          View.updateListener.of((update) => {
            if (update.docChanged) onchange(update.state.doc.toString());
          }),
          View.theme({
            "&": { height: "100%", fontSize: "13px" },
            ".cm-scroller": { fontFamily: "var(--font-mono)" },
          }),
        ],
      }),
    });

    view = created;
  })();

  return () => {
    disposed = true;
    view?.destroy();
    view = null;
  };
};

/**
 * Replace the document when the source changes from outside — a restored
 * version, or a new revision the model wrote. A change the student just typed
 * arrives here identical to what the editor already holds, so it is a no-op.
 */
$effect(() => {
  const next = value;
  const current = view;
  if (!current || current.state.doc.toString() === next) return;

  current.dispatch({ changes: { from: 0, to: current.state.doc.length, insert: next } });
});
</script>

<div {@attach editor} class="h-full overflow-hidden bg-background text-foreground"></div>
