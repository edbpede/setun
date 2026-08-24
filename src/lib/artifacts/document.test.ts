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
