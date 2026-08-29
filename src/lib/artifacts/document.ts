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

/**
 * The module graph this document carries, as source rather than as addresses.
 *
 * Source, because this document cannot fetch anything. It has an opaque origin
 * of its own — distinct from the runner's, since the stage frame is sandboxed on
 * its own account — so it can read neither the sandbox origin's files nor a blob
 * URL the runner made. What it *can* do is make blob URLs of its own, which is
 * what these become. See `assets.ts` for how they get here.
 *
 * `modules` is keyed by whatever the build calls a file — a `setun:` chunk
 * specifier, or an entry name — and `imports` maps every specifier an importer
 * may write to one of those keys. Two specifiers pointing at one key share a
 * blob URL, and therefore share a module instance: `react/jsx-runtime` and
 * `react/jsx-dev-runtime` must not become two Reacts.
 */
export interface RuntimeSources {
  /** Module key → its source. */
  readonly modules: Readonly<Record<string, string>>;
  /** Specifier an importer may write → the module key that satisfies it. */
  readonly imports: Readonly<Record<string, string>>;
  /** Specifiers to import for their effect alone, before the artifact runs. */
  readonly sideEffects?: readonly string[];
}

/**
 * The import map, over blob URLs this document makes for itself (§13).
 *
 * A blob URL is only knowable at run time, so the map cannot be static markup:
 * an inline script builds the URLs, appends the map, and only then appends the
 * module that names those specifiers. Order is the whole of it — an import map
 * added after a module script has begun loading is ignored — which is why the
 * harness is appended from inside this same script rather than written into the
 * body and left to the parser.
 *
 * Every runtime is registered under the specifiers that resolve to it, so the
 * bare names a model writes (`react`, `svelte/internal/client`) are unchanged.
 */
function modules(runtimes: RuntimeSources, harness: string): string {
  const sideEffects = (runtimes.sideEffects ?? []).filter(
    (specifier) => runtimes.imports[specifier],
  );

  return `<script>(function(){
var sources=${escapeScript(JSON.stringify(runtimes.modules))};
var specifiers=${escapeScript(JSON.stringify(runtimes.imports))};
var effects=${escapeScript(JSON.stringify(sideEffects))};
var urls={};
for (var key in sources) urls[key]=URL.createObjectURL(new Blob([sources[key]],{type:"text/javascript"}));
var imports={};
for (var specifier in specifiers) imports[specifier]=urls[specifiers[specifier]];
var map=document.createElement("script");map.type="importmap";map.textContent=JSON.stringify({imports:imports});document.head.appendChild(map);
var run=function(source){var tag=document.createElement("script");tag.type="module";tag.textContent=source;document.head.appendChild(tag)};
for (var i=0;i<effects.length;i++) run("import "+JSON.stringify(effects[i])+";");
var harness=${escapeScript(JSON.stringify(harness))};
if (harness) run(harness);
})();</script>`;
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
  runtimes: RuntimeSources;
  runId: string;
}): string {
  // A static artifact runs no module of its own, so the only thing the graph is
  // here for is UnoCSS — but it goes through the same script all the same, since
  // that runtime is itself a code-split entry with chunks to resolve.
  const head = `${preamble(input.runId)}\n${modules(input.runtimes, "")}`;
  const ack = "<script>window.__setunReady&&window.__setunReady();</script>";

  if (input.language === "svg") {
    return `<!doctype html><html><head><meta charset="utf-8">${head}<style>html,body{margin:0;height:100%;display:grid;place-items:center;background:#fff}svg{max-width:100%;max-height:100%}</style></head><body>${input.source}${ack}</body></html>`;
  }

  return injectIntoHtml(input.source, head, ack);
}

/**
 * Elements the parser does not read as markup: only their own end tag closes
 * them, and a tag named inside one is text. `noscript` belongs here because
 * scripting is always enabled in the frame an artifact runs in.
 */
const RAW_TEXT = new Set([
  "script",
  "style",
  "textarea",
  "title",
  "xmp",
  "iframe",
  "noembed",
  "noframes",
  "noscript",
]);

/**
 * Past the `>` that closes a start tag, with quoted attribute values skipped,
 * or -1 for a tag the source never closes — which the parser discards at the
 * end of input, and which is therefore no place to put the preamble.
 */
function tagEnd(source: string, from: number): number {
  let quote = "";

  for (let at = from; at < source.length; at += 1) {
    const char = source[at];

    if (quote) {
      if (char === quote) quote = "";
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === ">") {
      return at + 1;
    }
  }

  return -1;
}

/**
 * The end of the first real `<head>` or `<html>` start tag, or -1.
 *
 * A regular expression cannot answer this, and the artifact is hostile source
 * by assumption: `<head>` reads as ordinary text inside a comment, inside a
 * `<script>` or `<title>`, and inside a quoted attribute value. Inserting after
 * any of those buries the preamble where the browser reads none of it, leaving
 * the artifact on the origin's broader policy and the panel without its
 * lifecycle events. So the scan walks the source as the tokenizer does, past
 * every context in which `<` opens nothing.
 */
function structuralTagEnd(source: string, name: "head" | "html"): number {
  let at = 0;

  while (at < source.length) {
    const open = source.indexOf("<", at);
    if (open < 0) return -1;

    if (source.startsWith("<!--", open)) {
      const close = source.indexOf("-->", open + 4);
      at = close < 0 ? source.length : close + 3;
      continue;
    }

    // Doctypes and bogus `<!`/`<?` constructs run to the next `>`.
    if (source.startsWith("<!", open) || source.startsWith("<?", open)) {
      const close = source.indexOf(">", open);
      at = close < 0 ? source.length : close + 1;
      continue;
    }

    const tag = /^<(\/?)([a-zA-Z][^\s/>]*)/.exec(source.slice(open));
    if (!tag) {
      at = open + 1;
      continue;
    }

    const closesTag = tag[1] === "/";
    const tagName = tag[2].toLowerCase();
    const end = tagEnd(source, open + tag[0].length);

    // An unclosed tag swallows the rest of the input, so nothing follows it.
    if (end < 0) return -1;

    if (!closesTag && tagName === name) return end;

    // `<plaintext>` has no end tag — the parser stays in that mode to the end of
    // input, so a `</plaintext>` in the source closes nothing and no structural
    // tag can follow. Listing it beside the raw-text elements would look right
    // and hand back the same diversion, one string away.
    if (!closesTag && tagName === "plaintext") return -1;

    if (!closesTag && RAW_TEXT.has(tagName)) {
      // Resume at the end tag itself, which the loop then steps over normally.
      const close = new RegExp(`</${tagName}[\\s/>]`, "i").exec(source.slice(end));
      at = close ? end + close.index : source.length;
      continue;
    }

    at = end;
  }

  return -1;
}

/**
 * Put the preamble into whatever the model wrote.
 *
 * Models emit anything from a bare `<div>` to a full document with a doctype,
 * and rewriting their markup is not this function's job — it finds the earliest
 * position that is really inside the document and inserts there.
 */
function injectIntoHtml(source: string, head: string, ack: string): string {
  const headEnd = structuralTagEnd(source, "head");
  if (headEnd > -1) {
    return `${source.slice(0, headEnd)}${head}${source.slice(headEnd)}\n${ack}`;
  }

  const htmlEnd = structuralTagEnd(source, "html");
  if (htmlEnd > -1) {
    return `${source.slice(0, htmlEnd)}<head><meta charset="utf-8">${head}</head>${source.slice(htmlEnd)}\n${ack}`;
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
  runtimes: RuntimeSources;
  runId: string;
}): string {
  const mount =
    input.framework === "react"
      ? `const { createRoot } = await import("react-dom/client");
const { createElement } = await import("react");
createRoot(root).render(createElement(pick(module)));`
      : `const { mount } = await import("svelte");
mount(pick(module), { target: root });`;

  const harness = `
const source = ${JSON.stringify(input.module)};
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
  parent.postMessage({ channel: "setun-artifact", type: "runtime-error", runId: ${JSON.stringify(input.runId)}, message: String((error && error.message) || error) }, "*");
}
`;

  // Everything after the preamble is appended by one script, in one order: the
  // import map first, then the modules that resolve against it. A module script
  // in the markup — UnoCSS's, as it used to be — would begin loading before the
  // map existed, and a map added after that point is ignored.
  return `<!doctype html><html><head><meta charset="utf-8">
${preamble(input.runId)}
<style>html,body{margin:0}</style>
</head><body><div id="setun-root"></div>
${modules(input.runtimes, harness)}
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
