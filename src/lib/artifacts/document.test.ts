import { describe, expect, it } from "bun:test";
import { artifactTitle, compiledDocument, importMap, staticDocument } from "./document";

/**
 * The document an artifact runs in (plan 4.1, 4.3; PRD §13, §14, §22).
 *
 * These assertions are about containment, not appearance: the tightened policy
 * has to be present on every path, and artifact source has to be unable to break
 * out of the element it is interpolated into.
 */

const ORIGIN = "https://artifacts.example.org";

describe("staticDocument", () => {
  it("injects the preamble into a full document's head", () => {
    const html = staticDocument({
      language: "html",
      source: "<!doctype html><html><head><title>Kort</title></head><body>hi</body></html>",
      origin: ORIGIN,
      runId: "run-1",
    });

    expect(html).toContain("<title>Kort</title>");
    expect(html).toContain("connect-src 'none'");
    expect(html).toContain(`${ORIGIN}/runtimes/unocss.js`);
    // The model's own head content survives; nothing is rewritten.
    expect(html.indexOf("connect-src 'none'")).toBeLessThan(html.indexOf("<title>Kort</title>"));
  });

  it("wraps a bare fragment in a document of its own", () => {
    const html = staticDocument({
      language: "html",
      source: "<button>Klik</button>",
      origin: ORIGIN,
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
      origin: ORIGIN,
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
      origin: ORIGIN,
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
      const html = staticDocument({ language: "html", source, origin: ORIGIN, runId: "r" });
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
      const html = staticDocument({ language: "html", source, origin: ORIGIN, runId: "r" });
      expect(html).toContain("connect-src 'none'");
      expect(html).toContain("frame-src 'none'");
      expect(html).toContain("form-action 'none'");
      expect(html).toContain("base-uri 'none'");
    }
  });
});

describe("compiledDocument", () => {
  it("resolves bare specifiers to this origin's pinned runtimes", () => {
    const map = importMap(ORIGIN);

    expect(map).toContain(`${ORIGIN}/runtimes/react.js`);
    expect(map).toContain(`${ORIGIN}/runtimes/react-jsx-runtime.js`);
    expect(map).toContain(`${ORIGIN}/runtimes/svelte-internal-client.js`);
    // No other framework is hosted (§13), and no CDN is named anywhere.
    expect(map).not.toContain("cdn");
    expect(map).not.toContain("unpkg");
  });

  it("carries the compiled module and the mount harness", () => {
    const html = compiledDocument({
      framework: "react",
      module: 'export default () => "hi";',
      origin: ORIGIN,
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
      origin: ORIGIN,
      runId: "run-1",
    });

    expect(html).toContain('await import("svelte")');
    // The import map is the same for both frameworks; the harness is not.
    expect(html).not.toContain("createRoot");
  });

  it("cannot be broken out of with a closing script tag in the source", () => {
    const html = compiledDocument({
      framework: "react",
      // The tokenizer does not know it is inside a JavaScript string literal.
      module: 'const x = "</script><script>alert(1)</script>";',
      origin: ORIGIN,
      runId: "run-1",
    });

    expect(html).not.toContain("</script><script>alert(1)");
    expect(html).toContain("<\\/script>");
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
