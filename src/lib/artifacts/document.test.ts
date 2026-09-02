import { describe, expect, it } from "bun:test";
import { artifactTitle, compiledDocument, type RuntimeSources, staticDocument } from "./document";

/**
 * The document an artifact runs in (plan 4.1, 4.3; PRD §13, §14, §22).
 *
 * These assertions are about containment, not appearance: the tightened policy
 * has to be present on every path, and artifact source has to be unable to break
 * out of the element it is interpolated into.
 */

/**
 * A stand-in for the module graph the runner collects (see `assets.ts`).
 *
 * Sources rather than URLs, because the artifact's frame has an opaque origin of
 * its own and can fetch neither the sandbox host nor a blob the runner made — so
 * it builds its own blob URLs from these and an import map over them. `setun:`
 * keys are the shared chunks, whose relative references the build rewrites
 * because a relative specifier cannot resolve from a blob URL.
 */
const REACT: RuntimeSources = {
  modules: {
    react: '/* react */ import "setun:core.js"; export default {};',
    "react-jsx-runtime": "/* jsx runtime */ export const jsx = 1;",
    "react-dom-client": "/* react-dom/client */ export const createRoot = () => {};",
    "setun:core.js": "/* shared chunk */ export const core = 1;",
    unocss: "/* unocss */ export const uno = 1;",
  },
  imports: {
    react: "react",
    "react/jsx-runtime": "react-jsx-runtime",
    "react/jsx-dev-runtime": "react-jsx-runtime",
    "react-dom/client": "react-dom-client",
    "setun:core.js": "setun:core.js",
    unocss: "unocss",
  },
  sideEffects: ["unocss"],
};

const SVELTE: RuntimeSources = {
  modules: {
    svelte: "/* svelte */ export const mount = () => {};",
    "svelte-internal-client": "/* svelte internal */ export const x = 1;",
  },
  imports: { svelte: "svelte", "svelte/internal/client": "svelte-internal-client" },
};

const RUNTIMES = REACT;

describe("staticDocument", () => {
  it("injects the preamble into a full document's head", () => {
    const html = staticDocument({
      language: "html",
      source: "<!doctype html><html><head><title>Kort</title></head><body>hi</body></html>",
      runtimes: RUNTIMES,
      runId: "run-1",
    });

    expect(html).toContain("<title>Kort</title>");
    expect(html).toContain("connect-src 'none'");
    expect(html).toContain("/* unocss */");
    // The model's own head content survives; nothing is rewritten.
    expect(html.indexOf("connect-src 'none'")).toBeLessThan(html.indexOf("<title>Kort</title>"));
  });

  it("wraps a bare fragment in a document of its own", () => {
    const html = staticDocument({
      language: "html",
      source: "<button>Klik</button>",
      runtimes: RUNTIMES,
      runId: "run-1",
    });

    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("<button>Klik</button>");
    expect(html).toContain("connect-src 'none'");
  });

  it("gives a document without a head one", () => {
    const html = staticDocument({
      language: "html",
      source: "<html><body><p>hi</p></body></html>",
      runtimes: RUNTIMES,
      runId: "run-1",
    });

    expect(html).toContain("<head>");
    expect(html).toContain("connect-src 'none'");
    expect(html).toContain("<p>hi</p>");
  });

  it("centres an SVG in a document of its own", () => {
    const html = staticDocument({
      language: "svg",
      source: '<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>',
      runtimes: RUNTIMES,
      runId: "run-1",
    });

    expect(html).toContain("<circle");
    expect(html).toContain("connect-src 'none'");
  });

  it("is not diverted by a structural tag that is only text", () => {
    /**
     * Each source names a structural tag somewhere the parser reads no markup,
     * paired with the run of text that must come through untouched. Splitting
     * that run is what a context-blind scan does — and it buries the preamble
     * where the browser acts on none of it, leaving the artifact on the origin's
     * broader policy and the panel without its lifecycle events.
     *
     * `real` marks the sources that go on to open a document of their own: the
     * preamble belongs in *that* head, after the decoy, rather than in a wrapper
     * put in front of markup the artifact already had.
     */
    const diversions: readonly { source: string; intact: string; real: boolean }[] = [
      // Comments, including one holding a `>` of its own, and one unterminated.
      {
        source:
          "<!-- <head> --><!doctype html><html><head><title>Kort</title></head><body>hi</body></html>",
        intact: "<!-- <head> -->",
        real: true,
      },
      {
        source: "<!-- a > b <head> --><html><head></head><body>hi</body></html>",
        intact: "<!-- a > b <head> -->",
        real: true,
      },
      { source: "<!-- <html> --><p>hi</p>", intact: "<!-- <html> -->", real: false },
      // A bogus comment: the parser ends it at the first `>`, wherever that is.
      {
        source: "<!bogus <head> ><html><head></head><body>hi</body></html>",
        intact: "<!bogus <head> >",
        real: true,
      },
      {
        source: "<!-- an unterminated comment mentioning <head>",
        intact: "<!-- an unterminated comment mentioning <head>",
        real: false,
      },
      // `<plaintext>` runs to the end of input, and its own end tag does not
      // close it — so nothing after either one is a place for the preamble.
      {
        source: "<plaintext><html><head></head><body>hi</body></html>",
        intact: "<plaintext><html><head></head><body>hi</body></html>",
        real: false,
      },
      {
        source: "<plaintext></plaintext><html><head></head><body>hi</body></html>",
        intact: "<plaintext></plaintext><html><head></head><body>hi</body></html>",
        real: false,
      },
      // A tag the source never closes is discarded at the end of input, so the
      // preamble belongs in a wrapper rather than inside it.
      { source: "<div><head", intact: "<div><head", real: false },
      // Raw text and RCDATA: nothing inside these is markup.
      {
        source:
          '<script>const example = "<head>";</script><html><head></head><body>hi</body></html>',
        intact: '<script>const example = "<head>";</script>',
        real: true,
      },
      {
        source: "<style>/* <head> */</style><html><head></head><body>hi</body></html>",
        intact: "<style>/* <head> */</style>",
        real: true,
      },
      {
        source: "<title>about <head></title><html><head></head><body>hi</body></html>",
        intact: "<title>about <head></title>",
        real: true,
      },
      {
        source: "<textarea><head></textarea><html><head></head><body>hi</body></html>",
        intact: "<textarea><head></textarea>",
        real: true,
      },
      // A quoted attribute value, where `>` does not close the tag either.
      {
        source: '<div title="<head>"></div><html><head></head><body>hi</body></html>',
        intact: '<div title="<head>"></div>',
        real: true,
      },
      {
        source: "<div data-x='<html>'></div><html><head></head><body>hi</body></html>",
        intact: "<div data-x='<html>'></div>",
        real: true,
      },
    ];

    for (const { source, intact, real } of diversions) {
      const html = staticDocument({ language: "html", source, runtimes: RUNTIMES, runId: "r" });
      const policy = html.indexOf("connect-src 'none'");

      expect(html).toContain(intact);
      expect(policy).toBeGreaterThan(-1);
      expect(html).toContain("window.__setunReady");

      // Where the artifact opens a document of its own the decoy is passed over
      // and the preamble lands in that head, after it. Where it opens none, the
      // preamble is in the wrapper's head and the decoy follows it in the body.
      // Either way it is never the decoy itself that the preamble goes into.
      if (real) expect(policy).toBeGreaterThan(html.indexOf(intact));
      else expect(policy).toBeLessThan(html.indexOf(intact));
    }
  });

  it("denies outbound network and framing on every path", () => {
    for (const source of ["<p>x</p>", "<html><body>x</body></html>", "<head></head>"]) {
      const html = staticDocument({ language: "html", source, runtimes: RUNTIMES, runId: "r" });
      expect(html).toContain("connect-src 'none'");
      expect(html).toContain("frame-src 'none'");
      expect(html).toContain("form-action 'none'");
      expect(html).toContain("base-uri 'none'");
    }
  });
});

describe("compiledDocument", () => {
  it("resolves bare specifiers to the runtimes it carries", () => {
    const html = compiledDocument({
      framework: "react",
      module: 'export default () => "hi";',
      runtimes: RUNTIMES,
      runId: "run-1",
    });

    // The map is built at run time over blob URLs, so what the document carries
    // is the specifier table and the sources — never an address to fetch.
    expect(html).toContain('"react/jsx-runtime"');
    expect(html).toContain('"react-dom/client"');
    expect(html).toContain("/* react */");
    expect(html).toContain('type="importmap"');
    // No other framework is hosted (§13), and no CDN is named anywhere.
    expect(html).not.toContain("cdn");
    expect(html).not.toContain("unpkg");
  });

  it("names only the specifiers it has a runtime for", () => {
    const html = compiledDocument({
      framework: "svelte",
      module: "export default function App() {}",
      runtimes: SVELTE,
      runId: "run-1",
    });

    expect(html).toContain('"svelte/internal/client"');
    // A Svelte lesson never carries React, so the map cannot name it either.
    expect(html).not.toContain('"react-dom/client"');
  });

  it("carries a shared chunk under the specifier the build rewrote it to", () => {
    const html = compiledDocument({
      framework: "react",
      module: 'export default () => "hi";',
      runtimes: REACT,
      runId: "run-1",
    });

    // `react` and `react-dom/client` share React itself; duplicating it would
    // give the artifact two Reacts and no working hooks. So the chunk travels
    // once and both entries import it by name.
    expect(html).toContain("setun:core.js");
    expect(html).toContain("/* shared chunk */");
  });

  it("registers the import map before any module that resolves against it", () => {
    const html = compiledDocument({
      framework: "react",
      module: 'export default () => "hi";',
      runtimes: RUNTIMES,
      runId: "run-1",
    });

    // An import map added after a module script has begun loading is ignored, so
    // no module is left to the parser at all: the script that registers the map
    // appends every one of them itself, in order.
    expect(html).not.toContain('<script type="module"');
  });

  it("carries the compiled module and the mount harness", () => {
    const html = compiledDocument({
      framework: "react",
      module: 'export default () => "hi";',
      runtimes: RUNTIMES,
      runId: "run-1",
    });

    expect(html).toContain("react-dom/client");
    expect(html).toContain("setun-root");
    expect(html).toContain("connect-src 'none'");
  });

  it("mounts a Svelte component through the Svelte runtime", () => {
    const html = compiledDocument({
      framework: "svelte",
      module: "export default function App() {}",
      runtimes: RUNTIMES,
      runId: "run-1",
    });

    // The harness travels as a JSON string inside the script that appends it,
    // so its own quotes are escaped by the time they reach the markup.
    expect(html).toContain('await import(\\"svelte\\")');
    // The specifier table is the same for both frameworks; the harness is not.
    expect(html).not.toContain("createRoot(root)");
  });

  it("cannot be broken out of with a closing script tag in the source", () => {
    const html = compiledDocument({
      framework: "react",
      // The tokenizer does not know it is inside a JavaScript string literal.
      module: 'const x = "</script><script>alert(1)</script>";',
      runtimes: RUNTIMES,
      runId: "run-1",
    });

    expect(html).not.toContain("</script><script>alert(1)");
    expect(html).toContain("<\\/script>");
  });
});

describe("the document preamble", () => {
  const base = { language: "html" as const, runtimes: REACT, runId: "run-1" };

  it("seeds the storage shim with what the artifact held on its last run", () => {
    const html = staticDocument({
      ...base,
      source: "<p>hi</p>",
      storage: { local: { score: "12" }, session: {} },
    });

    expect(html).toContain('{"local":{"score":"12"},"session":{}}');
    expect(html).toContain('install("local");install("session")');
  });

  it("seeds both areas empty when nothing was kept", () => {
    expect(staticDocument({ ...base, source: "<p>hi</p>" })).toContain('{"local":{},"session":{}}');
  });

  it("installs the shim only where the native object is unreachable", () => {
    // The probe: a frame that *can* reach `localStorage` keeps it, so relaxing
    // the sandbox later does not leave two storages in play.
    expect(staticDocument({ ...base, source: "<p>hi</p>" })).toContain(
      'try{var native=window[name];native.getItem("__setun__");return}catch(e){}',
    );
  });

  it("cannot be broken out of by a stored value holding a closing script tag", () => {
    const html = staticDocument({
      ...base,
      source: "<p>hi</p>",
      storage: { local: { evil: "</script><script>alert(1)</script>" } },
    });

    // The whole seed, not merely "an escape happened somewhere": one raw
    // closing tag left anywhere in the value ends the preamble script early,
    // and escaping only the first occurrence would satisfy a looser assertion.
    expect(html).toContain(
      '{"local":{"evil":"<\\/script><script>alert(1)<\\/script>"},"session":{}}',
    );
  });

  it("counts the quota in bytes, and an overwrite only once", () => {
    const html = staticDocument({ ...base, source: "<p>hi</p>" });

    // "æ" is two bytes and .length says one, so the shim measures the encoding.
    expect(html).toContain("var bytes=sizeOf(k)+sizeOf(v);");
    // And the key being replaced is not counted twice, which refused a write
    // that fits whenever an artifact updated an existing key near the bound.
    expect(html).toContain("for(var held in data){if(held===k)continue;");
  });

  it("keeps the shim enumerable, so Object.keys does not throw on it", () => {
    // A Proxy whose ownKeys omits a non-configurable property of its target is
    // a TypeError on every enumeration — `length` has to be configurable.
    expect(staticDocument({ ...base, source: "<p>hi</p>" })).toContain(
      "return Object.keys(data).length},configurable:true}",
    );
  });

  it("copies console output upward while still calling the original", () => {
    const html = staticDocument({ ...base, source: "<p>hi</p>" });

    expect(html).toContain("original&&original.apply(console,arguments)");
    expect(html).toContain('type:"console"');
  });

  it("carries the shim and the console capture into a compiled document too", () => {
    const html = compiledDocument({
      framework: "react",
      module: "export default () => null;",
      runtimes: REACT,
      runId: "run-1",
      storage: { session: { turn: "3" } },
    });

    expect(html).toContain('"session":{"turn":"3"}');
    expect(html).toContain('type:"console"');
  });
});

describe("artifactTitle", () => {
  it("reads a document title", () => {
    expect(artifactTitle("<html><head><title>Mit kort</title></head></html>")).toBe("Mit kort");
  });

  it("falls back to a leading heading comment", () => {
    expect(artifactTitle("// # Tællerknap\nexport default () => null;")).toBe("Tællerknap");
  });

  it("returns null when the source names nothing", () => {
    expect(artifactTitle("<button>Klik</button>")).toBeNull();
  });
});
