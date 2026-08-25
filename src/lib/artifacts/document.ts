import type { ArtifactLanguage } from "./types";

/**
 * The document an artifact runs in (PRD §13, §14).
 *
 * Generated code is untrusted and treated as hostile, so it never runs in the
 * runner page itself: the runner assembles a document and hands it to a nested
 * `srcdoc` frame, which gets its own opaque origin and inherits the sandbox
 * origin's content security policy. The runner's own bridge to the application
 * therefore sits behind an origin boundary from the code it is displaying.
 *
 * Assembly is pure string work with no DOM, which is why it lives here — under
 * `bun test` — rather than in `sandbox/`, where nothing could reach it.
 */

/**
 * Tightened further than the origin's own policy (§14).
 *
 * A `srcdoc` document inherits its parent's policy, and additional policies
 * intersect rather than replace — so this only ever removes capability. The
 * runner needs `connect-src` for the compiler and its runtimes; the artifact
 * needs none at all, which is what "denies outbound network access by default"
 * means for the code being run.
 */
const INNER_POLICY = [
  "connect-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

/**
 * Errors are reported to the runner rather than swallowed.
 *
 * `parent` here is the runner page, one origin boundary away; it forwards to
 * the application, which is another. Nothing about the message is trusted at
 * either hop — it is rendered as text.
 */
function preamble(runId: string): string {
  const id = JSON.stringify(runId);

  return `<meta http-equiv="Content-Security-Policy" content="${INNER_POLICY}">
<script>(function(){
var post=function(type,message){try{parent.postMessage({channel:"setun-artifact",type:type,runId:${id},message:message},"*")}catch(e){}};
addEventListener("error",function(e){post("runtime-error",String(e.message||"Error"))});
addEventListener("unhandledrejection",function(e){post("runtime-error",String((e.reason&&e.reason.message)||e.reason||"Error"))});
window.__setunReady=function(){post("mounted","")};
})();</script>`;
}

/** The self-hosted utility CSS runtime; no public CDN is contacted (§13). */
function unocss(origin: string): string {
  return `<script type="module" src="${origin}/runtimes/unocss.js"></script>`;
}

/**
 * Bare specifiers the compiled module may name, mapped to the pinned runtimes
 * this origin serves (§13). React and Svelte only — no other framework is hosted.
 */
export function importMap(origin: string): string {
  const imports = {
    react: `${origin}/runtimes/react.js`,
    "react/jsx-runtime": `${origin}/runtimes/react-jsx-runtime.js`,
    "react/jsx-dev-runtime": `${origin}/runtimes/react-jsx-runtime.js`,
    "react-dom": `${origin}/runtimes/react-dom.js`,
    "react-dom/client": `${origin}/runtimes/react-dom-client.js`,
    svelte: `${origin}/runtimes/svelte.js`,
    "svelte/internal/client": `${origin}/runtimes/svelte-internal-client.js`,
    "svelte/internal/disclose-version": `${origin}/runtimes/svelte-disclose-version.js`,
    "svelte/internal/flags/legacy": `${origin}/runtimes/svelte-flags-legacy.js`,
    "svelte/internal/flags/async": `${origin}/runtimes/svelte-flags-async.js`,
  };

  return `<script type="importmap">${escapeScript(JSON.stringify({ imports }))}</script>`;
}

/**
 * A string safe to embed inside a `<script>` element.
 *
 * `</script>` inside a JavaScript string literal still closes the element —
 * the HTML tokenizer does not know it is inside a string — so the sequence is
 * broken up. This is the one place artifact source is interpolated into markup.
 */
function escapeScript(value: string): string {
  return value.replace(/<\/(script)/gi, "<\\/$1").replace(/<!--/g, "<\\!--");
}

/** The static tiers: HTML documents and SVG render with no build step (§13). */
export function staticDocument(input: {
  language: Extract<ArtifactLanguage, "html" | "svg">;
  source: string;
  origin: string;
  runId: string;
}): string {
  const head = `${preamble(input.runId)}\n${unocss(input.origin)}`;
  const ack = "<script>window.__setunReady&&window.__setunReady();</script>";

  if (input.language === "svg") {
    return `<!doctype html><html><head><meta charset="utf-8">${head}<style>html,body{margin:0;height:100%;display:grid;place-items:center;background:#fff}svg{max-width:100%;max-height:100%}</style></head><body>${input.source}${ack}</body></html>`;
  }

  return injectIntoHtml(input.source, head, ack);
}

/**
 * The source with comment bodies blanked out, one space per character.
 *
 * A tag named inside a comment is not a tag, and inserting the preamble after
 * one would bury the whole of it inside that comment — where the browser reads
 * none of it, leaving the artifact on the origin's broader policy and the panel
 * without its lifecycle events. Blanking rather than removing keeps every index
 * valid against the original string. An unterminated comment runs to the end,
 * as the parser treats it.
 */
function maskComments(source: string): string {
  return source.replace(/<!--[\s\S]*?(?:-->|$)/g, (comment) => " ".repeat(comment.length));
}

/**
 * Put the preamble into whatever the model wrote.
 *
 * Models emit anything from a bare `<div>` to a full document with a doctype,
 * and rewriting their markup is not this function's job — it finds the earliest
 * position that is inside the document and inserts there. Positions are found
 * against the masked source and applied to the real one.
 */
function injectIntoHtml(source: string, head: string, ack: string): string {
  const scan = maskComments(source);

  const headOpen = /<head[^>]*>/i.exec(scan);
  if (headOpen) {
    const at = headOpen.index + headOpen[0].length;
    return `${source.slice(0, at)}${head}${source.slice(at)}\n${ack}`;
  }

  const htmlOpen = /<html[^>]*>/i.exec(scan);
  if (htmlOpen) {
    const at = htmlOpen.index + htmlOpen[0].length;
    return `${source.slice(0, at)}<head><meta charset="utf-8">${head}</head>${source.slice(at)}\n${ack}`;
  }

  return `<!doctype html><html><head><meta charset="utf-8">${head}</head><body>${source}\n${ack}</body></html>`;
}

/**
 * The compiled tier: a module the browser imports from a blob URL (§13).
 *
 * The compiled code keeps whatever name the model gave its default export, so
 * the harness imports the module rather than concatenating a call onto it —
 * concatenation would have to guess an identifier that is not knowable.
 */
export function compiledDocument(input: {
  framework: "react" | "svelte";
  /** ES module source, already through `esbuild-wasm` or the Svelte compiler. */
  module: string;
  origin: string;
  runId: string;
}): string {
  const mount =
    input.framework === "react"
      ? `const { createRoot } = await import("react-dom/client");
const { createElement } = await import("react");
createRoot(root).render(createElement(pick(module)));`
      : `const { mount } = await import("svelte");
mount(pick(module), { target: root });`;

  const harness = `<script type="module">
const source = ${escapeScript(JSON.stringify(input.module))};
const root = document.getElementById("setun-root");
const pick = (m) => {
  const component = m.default ?? m.App ?? Object.values(m).find((v) => typeof v === "function");
  if (!component) throw new Error("The artifact exports no component to render.");
  return component;
};
try {
  const module = await import(URL.createObjectURL(new Blob([source], { type: "text/javascript" })));
  ${mount}
  window.__setunReady && window.__setunReady();
} catch (error) {
  parent.postMessage({ channel: "setun-artifact", type: "runtime-error", runId: ${escapeScript(JSON.stringify(input.runId))}, message: String((error && error.message) || error) }, "*");
}
</script>`;

  return `<!doctype html><html><head><meta charset="utf-8">
${preamble(input.runId)}
${importMap(input.origin)}
${unocss(input.origin)}
<style>html,body{margin:0}</style>
</head><body><div id="setun-root"></div>
${harness}
</body></html>`;
}

/**
 * A name for the creations gallery, read out of the artifact itself (§13, §16).
 *
 * Null when the source offers none; the interface then names it by language, in
 * the reader's own language, rather than inventing an English one here.
 */
export function artifactTitle(source: string): string | null {
  const title = /<title[^>]*>([^<]{1,120})<\/title>/i.exec(source)?.[1]?.trim();
  if (title) return title;

  const heading = /^\s*(?:\/\/|\/\*|<!--)?\s*#\s+(.{1,120})$/m.exec(source)?.[1]?.trim();
  return heading || null;
}
