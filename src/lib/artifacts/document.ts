import { findProjectFile, kindOf, type ProjectFiles, resolveRelative } from "./project";
import {
  CONSOLE_MAX_LINES,
  CONSOLE_MAX_TEXT,
  STORAGE_MAX_BYTES,
  STORAGE_MAX_KEYS,
} from "./protocol";
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
 * What an artifact gets besides its own source (PRD §13, §14).
 *
 * Three things, all of them installed before a line of generated code runs:
 *
 * 1. **Error reporting.** `parent` here is the runner page, one origin boundary
 *    away; it forwards to the application, which is another. Nothing about the
 *    message is trusted at either hop — it is rendered as text.
 * 2. **A storage shim.** The frame is sandboxed without `allow-same-origin`, so
 *    its origin is opaque — and in an opaque origin `localStorage` *throws*
 *    rather than returning null. A small game that saves a high score therefore
 *    died on the line where it tried, which is not a lesson about anything. So
 *    an in-memory `Storage` stands in, seeded with what this artifact held on
 *    its last run and posted back to the runner as it changes. It is bounded and
 *    it is not durable: the runner holds it while the panel is open, nothing
 *    reaches the application, and the model is told as much in its instructions.
 * 3. **Console capture.** `console.log` in a nested opaque frame went nowhere a
 *    pupil could look. The originals still run; the text is batched upward.
 *
 * The shim is installed only where the native object is unreachable, so a future
 * relaxation of the frame's sandbox does not leave two storages in play.
 */
function preamble(runId: string, storage?: ArtifactStorageSeed): string {
  const id = JSON.stringify(runId);
  const seed = escapeScript(
    JSON.stringify({ local: storage?.local ?? {}, session: storage?.session ?? {} }),
  );

  return `<meta http-equiv="Content-Security-Policy" content="${INNER_POLICY}">
<script>(function(){
var post=function(type,message){try{parent.postMessage({channel:"setun-artifact",type:type,runId:${id},message:message},"*")}catch(e){}};
var send=function(payload){try{parent.postMessage(payload,"*")}catch(e){}};
addEventListener("error",function(e){post("runtime-error",String(e.message||"Error"))});
addEventListener("unhandledrejection",function(e){post("runtime-error",String((e.reason&&e.reason.message)||e.reason||"Error"))});
window.__setunReady=function(){post("mounted","")};

/* The storage shim. Bounded at ${STORAGE_MAX_KEYS} keys and ${STORAGE_MAX_BYTES} bytes,
   which is what the runner will keep and what the model is told it has. */
var seed=${seed};
var install=function(area){
  var name=area==="local"?"localStorage":"sessionStorage";
  try{var native=window[name];native.getItem("__setun__");return}catch(e){}
  /* Null-prototype: assigning the key __proto__ on an ordinary object invokes
     the prototype setter and silently drops a key the artifact stored. */
  var data=Object.assign(Object.create(null),seed[area]||{});
  var timer=null;
  var flush=function(){if(timer){clearTimeout(timer);timer=null}send({channel:"setun-artifact",type:"storage",runId:${id},area:area,entries:data})};
  var schedule=function(){if(timer)return;timer=setTimeout(function(){timer=null;flush()},250)};
  var quota=function(){var e=new Error("The artifact's storage is full.");e.name="QuotaExceededError";return e};
  /* The bound is bytes, and .length counts UTF-16 units — "æ" is two bytes and
     an emoji four, so a Danish page would otherwise keep more than it is told. */
  var sizeOf=function(s){try{return new TextEncoder().encode(s).length}catch(e){return s.length}};
  var api={
    getItem:function(k){k=String(k);return Object.prototype.hasOwnProperty.call(data,k)?data[k]:null},
    setItem:function(k,v){
      k=String(k);v=String(v);
      var bytes=sizeOf(k)+sizeOf(v);
      /* Skipping k: overwriting a key replaces its value rather than adding to
         it, and counting both copies refused a write that fits. */
      for(var held in data){if(held===k)continue;bytes+=sizeOf(held)+sizeOf(data[held])}
      if(bytes>${STORAGE_MAX_BYTES})throw quota();
      if(!Object.prototype.hasOwnProperty.call(data,k)&&Object.keys(data).length>=${STORAGE_MAX_KEYS})throw quota();
      data[k]=v;schedule()
    },
    removeItem:function(k){delete data[String(k)];schedule()},
    clear:function(){data=Object.create(null);schedule()},
    key:function(i){var keys=Object.keys(data);return i<keys.length?keys[i]:null}
  };
  /* Configurable, or the Proxy's ownKeys trap below breaks an invariant — it
     does not report length, and Object.keys(storage) would throw outright. */
  Object.defineProperty(api,"length",{get:function(){return Object.keys(data).length},configurable:true});
  /* A Proxy, because artifacts write \`storage.score = 3\` as often as they call
     \`setItem\` — the named-property access is part of the interface, not sugar. */
  var shim=new Proxy(api,{
    get:function(target,key){
      if(key in target)return target[key];
      return typeof key==="string"&&Object.prototype.hasOwnProperty.call(data,key)?data[key]:undefined
    },
    set:function(target,key,value){if(typeof key==="string")api.setItem(key,value);return true},
    has:function(target,key){return key in target||Object.prototype.hasOwnProperty.call(data,key)},
    deleteProperty:function(target,key){api.removeItem(key);return true},
    ownKeys:function(){return Object.keys(data)},
    getOwnPropertyDescriptor:function(target,key){
      return Object.prototype.hasOwnProperty.call(data,key)
        ?{value:data[key],writable:true,enumerable:true,configurable:true}
        :Object.getOwnPropertyDescriptor(target,key)
    }
  });
  try{Object.defineProperty(window,name,{value:shim,configurable:true,writable:false})}catch(e){}
  addEventListener("pagehide",flush);
};
install("local");install("session");

/* Console capture. The originals still run — a pupil with devtools open should
   see what they printed there too — and the copy is batched upward. */
(function(){
var queue=[],sent=0,timer=null;
var flush=function(){timer=null;if(queue.length===0)return;var batch=queue.splice(0,${CONSOLE_MAX_LINES});send({channel:"setun-artifact",type:"console",runId:${id},lines:batch});if(queue.length)timer=setTimeout(flush,100)};
var say=function(value){
  if(typeof value==="string")return value;
  if(value instanceof Error)return String(value.stack||value.message||value);
  try{return JSON.stringify(value)??String(value)}catch(e){return String(value)}
};
var levels=["log","warn","error","info","debug"];
for(var i=0;i<levels.length;i++)(function(level){
  var original=console[level];
  console[level]=function(){
    try{original&&original.apply(console,arguments)}catch(e){}
    if(sent>=500)return;
    sent++;
    var text="";
    for(var a=0;a<arguments.length;a++)text+=(a?" ":"")+say(arguments[a]);
    queue.push({level:level,text:text.slice(0,${CONSOLE_MAX_TEXT})});
    if(!timer)timer=setTimeout(flush,100)
  }
})(levels[i]);
})();
})();</script>`;
}

/** What an artifact's storage shim starts a run holding, per area. */
export interface ArtifactStorageSeed {
  readonly local?: Readonly<Record<string, string>>;
  readonly session?: Readonly<Record<string, string>>;
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
  storage?: ArtifactStorageSeed;
  /** Which file this source is, so a relative reference resolves against it. */
  entry?: string;
  /**
   * The rest of the project, so the entry's own links resolve (§13).
   *
   * A static artifact is not bundled — there is nothing to bundle — so a page
   * that links a stylesheet or a script of its own has those inlined here. The
   * frame has no network and no origin to fetch from, so an untouched
   * `<link href="styles.css">` would silently do nothing.
   */
  files?: ProjectFiles;
}): string {
  // A static artifact runs no module of its own, so the only thing the graph is
  // here for is UnoCSS — but it goes through the same script all the same, since
  // that runtime is itself a code-split entry with chunks to resolve.
  const head = `${preamble(input.runId, input.storage)}\n${modules(input.runtimes, "")}`;
  const ack = "<script>window.__setunReady&&window.__setunReady();</script>";

  if (input.language === "svg") {
    return `<!doctype html><html><head><meta charset="utf-8">${head}<style>html,body{margin:0;height:100%;display:grid;place-items:center;background:#fff}svg{max-width:100%;max-height:100%}</style></head><body>${input.source}${ack}</body></html>`;
  }

  const source = input.files
    ? inlineStaticSiblings(input.source, entryFor(input), input.files)
    : input.source;

  return injectIntoHtml(source, head, ack);
}

/** Where the entry sits, so a relative reference resolves against its folder. */
function entryFor(input: { files?: ProjectFiles; entry?: string }): string {
  return input.entry ?? "index.html";
}

/**
 * A `</style` or `</script` sequence inside inlined content (§21).
 *
 * The parser ends an element at the first matching end tag whatever the quoting
 * around it, so a stylesheet holding the literal text `</style` would close the
 * block and put the rest of the file on the page as markup. Escaped rather than
 * removed: what a pupil wrote stays what a pupil wrote.
 */
function escapeStyle(css: string): string {
  // A CSS hex escape, which the CSS parser reads back as the same character.
  return css.replace(/<\/(style)/gi, "<\\3c /$1");
}

/** `<link rel=stylesheet href=…>` and `<script src=…></script>` in the entry's markup. */
const STYLESHEET_LINK = /<link\b[^>]*?href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>/gi;
const SCRIPT_SRC = /<script\b[^>]*?src\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>\s*<\/script>/gi;

/**
 * Inline the project files an html entry references (§13).
 *
 * There is no server behind the frame, so a reference is either inlined here or
 * it does nothing. Only references that name a file of *this* project are
 * touched: an absolute URL, a data URI, or a path the project does not hold is
 * left exactly as written, so the page still says what the pupil wrote and the
 * frame's own network policy is what refuses it.
 */
export function inlineStaticSiblings(source: string, entry: string, files: ProjectFiles): string {
  const resolve = (raw: string | undefined): string | null => {
    if (!raw) return null;
    const specifier = raw.trim();
    // Anything that is not a plain relative path is somebody else's to resolve.
    if (specifier === "" || /^[a-z][a-z0-9+.-]*:/i.test(specifier) || specifier.startsWith("//")) {
      return null;
    }

    const resolved = resolveRelative(entry, specifier.replace(/^\//, "./"));
    return resolved ? findProjectFile(files, resolved) : null;
  };

  const withLinks = source.replace(STYLESHEET_LINK, (whole, _quoted, dq, sq, bare) => {
    if (!/rel\s*=\s*["']?stylesheet["']?/i.test(whole)) return whole;

    const path = resolve(dq ?? sq ?? bare);
    if (path === null || kindOf(path) !== "css") return whole;

    return `<style>${escapeStyle(files[path])}</style>`;
  });

  return withLinks.replace(SCRIPT_SRC, (whole, _quoted, dq, sq, bare) => {
    const path = resolve(dq ?? sq ?? bare);
    const kind = path === null ? null : kindOf(path);
    if (path === null || (kind !== "js" && kind !== "json")) return whole;

    // The attributes are kept — `type=module`, `defer` — because they change how
    // the browser runs it and the pupil wrote them on purpose.
    const attributes = whole
      .slice("<script".length, whole.indexOf(">"))
      .replace(SCRIPT_SRC_ATTRIBUTE, "");
    return `<script${attributes}>${escapeScript(files[path])}</script>`;
  });
}

const SCRIPT_SRC_ATTRIBUTE = /\ssrc\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/i;

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
  /**
   * The stylesheets the bundle imported, concatenated (§13).
   *
   * esbuild lifts every imported `.css` file into an output of its own, so it
   * arrives beside the module rather than inside it. Injected after the reset
   * below and before the artifact mounts, so a component's own injected styles —
   * Svelte's, which land at mount — still win, as they do in a real build.
   */
  css?: string;
  runtimes: RuntimeSources;
  runId: string;
  storage?: ArtifactStorageSeed;
}): string {
  const mount =
    input.framework === "react"
      ? // Synchronous on purpose. `render()` schedules, so a component that
        // throws while rendering throws *after* this harness has already acked
        // the mount — the error then reaches the preamble's global handler as a
        // late `runtime-error`, and a build failure is reported as a page that
        // ran and then broke. `flushSync` plus `onUncaughtError` (React 19)
        // brings the throw back inside the `try` below, which already reports it.
        //
        // The flag is separate from the value: `throw null` and `throw ""` are
        // legal, and testing the caught value itself would read those as no
        // crash at all and ack a mount that never happened.
        `const { createRoot } = await import("react-dom/client");
const { flushSync } = await import("react-dom");
const { createElement } = await import("react");
let crashed = false;
let crash = null;
const app = createRoot(root, { onUncaughtError: (error) => { crashed = true; crash = error; } });
flushSync(() => app.render(createElement(pick(module))));
if (crashed) throw crash;`
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
  const styles = input.css ? `<style>${escapeStyle(input.css)}</style>` : "";

  return `<!doctype html><html><head><meta charset="utf-8">
${preamble(input.runId, input.storage)}
<style>html,body{margin:0}</style>
${styles}
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
