import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

/**
 * The sandbox origin's own build (PRD §6, §13, §14).
 *
 * "The sandbox origin is prebuilt static files served directly by Caddy — the
 * application never serves the sandbox hostname. Those files are built from
 * `sandbox/` by the repository's own build step and mounted into the Caddy
 * container; in development, Vite serves the sandbox on a second localhost port
 * so both origins exist locally."
 *
 * Deliberately not part of the SvelteKit build: sharing one build would mean one
 * origin, and origin separation is the entire isolation mechanism (§14).
 */

const root = fileURLToPath(new URL(".", import.meta.url));
const repository = fileURLToPath(new URL("..", import.meta.url));

/**
 * The pinned runtimes, keyed by the path the artifact's import map names.
 *
 * Rollup names entry chunks after these keys, so the emitted filenames are
 * stable — an import map cannot point at a hashed name it does not know.
 */
const RUNTIMES = [
  "react",
  "react-dom",
  "react-dom-client",
  "react-jsx-runtime",
  "svelte",
  "svelte-internal-client",
  "svelte-disclose-version",
  "svelte-flags-legacy",
  "svelte-flags-async",
  "svelte-compiler",
  "unocss",
] as const;

const runtimeInputs = Object.fromEntries(
  RUNTIMES.map((name) => [`runtimes/${name}`, `${root}src/runtimes/${name}.ts`]),
);

/**
 * The sandbox is built in two passes (see `build:sandbox`).
 *
 * The runner has to end up as a single self-contained script inlined into
 * `index.html`, which means `inlineDynamicImports` — and Rollup only allows that
 * for a build with exactly one input. The pinned runtimes are eleven separate
 * entries by design, because an artifact's import map names them individually.
 * One pass cannot be both, so each pass builds what it needs and the runtimes
 * pass is told not to empty the directory the runner pass just filled.
 */
const target = process.env.SETUN_SANDBOX_BUILD_TARGET === "runtimes" ? "runtimes" : "runner";

/** Matches the Caddy site block; overridden for the end-to-end run. */
const port = Number(process.env.SETUN_SANDBOX_PORT ?? 5174);
const host = `localhost:${port}`;

/**
 * The same policy the Caddyfile serves in production, addressed at the local
 * host instead (PRD §14).
 *
 * `'self'` is deliberately not used: the runner document is sandboxed without
 * `allow-same-origin`, so its origin is opaque and `'self'` matches nothing.
 * Every allowance therefore names the host outright.
 *
 * Present in development and in the end-to-end run because it is the mechanism
 * under test — a sandbox that is only locked down in production is a sandbox
 * whose lockdown nothing verifies (§22).
 */
const CSP = [
  "default-src 'none'",
  `script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob: ${host}`,
  `style-src 'unsafe-inline' ${host}`,
  `img-src data: blob: ${host}`,
  `font-src data: ${host}`,
  "media-src data: blob:",
  `connect-src blob: data: ${host}`,
  "worker-src blob:",
  "frame-src 'self' blob: data:",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

/**
 * Everything this origin serves is public, static, and carries no credential —
 * so `*` is the correct value and not a concession.
 *
 * It is also *required*: the runner runs in a frame sandboxed without
 * `allow-same-origin`, which gives its document an opaque origin, and a module
 * script fetched by an opaque-origin document is a cross-origin request even
 * when it comes from the very host the document was loaded from.
 */
const HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": CSP,
  "Referrer-Policy": "no-referrer",
};

export default defineConfig({
  root,
  // No history fallback: this origin serves the files it has and 404s otherwise,
  // exactly as Caddy's `file_server` does. A dev server that answered every path
  // with the runner page would hide a route the real deployment does not have.
  appType: "mpa",
  // The application's own environment must not leak into artifact code.
  envPrefix: "SANDBOX_",
  define: { "process.env.NODE_ENV": '"production"' },
  resolve: {
    // Pure, dependency-free artifact logic is shared with the application so it
    // is covered by the repository's own test gates rather than living here
    // where nothing could reach it.
    alias: { $lib: `${repository}src/lib` },
  },
  /**
   * A classic worker, not a module worker (PRD §13, §14).
   *
   * The runner's document is sandboxed without `allow-same-origin`, so its
   * origin is opaque and the only worker script it may load is a blob it made
   * itself. Chrome starts a *classic* blob worker there; a module blob worker
   * fails to fetch its own script and dies before running a line.
   */
  worker: { format: "iife" },
  build: {
    // Outside `build/`: adapter-node empties that directory on every application
    // build, and the two builds are independent by design (§6).
    outDir: `${repository}build-sandbox`,
    // Only the first pass clears the directory; the second adds to it.
    emptyOutDir: target === "runner",
    target: "es2022",
    // Vite's preload helper rewrites dynamic imports to reference a
    // `__VITE_PRELOAD__` constant it substitutes when it emits the chunk. The
    // runner is inlined into the HTML rather than emitted, so that substitution
    // never happens and the constant reaches the browser undefined — the
    // compiler worker then dies on `__VITE_PRELOAD__ is not defined` the first
    // time a pupil opens a non-static artifact. Nothing here benefits from
    // preloading anyway: after inlining there is only one script.
    modulePreload: false,
    rollupOptions: {
      // Without this the runtime entries are tree-shaken down to their side
      // effects: nothing in this build imports them, because what imports them
      // is an artifact's import map at runtime.
      preserveEntrySignatures: "strict",
      input: target === "runtimes" ? { ...runtimeInputs } : { index: `${root}index.html` },
      output: {
        // One chunk, so the compiler worker travels inside the inlined runner
        // instead of behind a fetch an opaque origin is not allowed to make.
        inlineDynamicImports: target === "runner",
        entryFileNames: (chunk) =>
          chunk.name.startsWith("runtimes/") ? "[name].js" : "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
  // Vite's own CORS middleware refuses an `Origin: null` request, which is
  // exactly what the sandboxed frame sends; the header is set outright instead.
  server: { port, strictPort: true, cors: false, headers: HEADERS },
  preview: { port, strictPort: true, cors: false, headers: HEADERS },
  plugins: [
    {
      name: "setun-sandbox-runtime-paths",
      /**
       * In development the runtimes are still TypeScript sources. The import map
       * and the worker name the built paths, so the dev server answers those
       * paths with the module Vite would have transformed anyway — rather than
       * the two environments disagreeing about what a runtime is called.
       */
      configureServer(server) {
        server.middlewares.use((request, _response, next) => {
          const match = /^\/runtimes\/([\w-]+)\.js(\?.*)?$/.exec(request.url ?? "");
          if (match) request.url = `/src/runtimes/${match[1]}.ts`;
          next();
        });
      },
    },
    {
      name: "setun-sandbox-inline-runner",
      /**
       * Inline the runner into `index.html` instead of linking it (PRD §13, §14).
       *
       * The runner document is sandboxed without `allow-same-origin`, so its
       * origin is opaque — and a document with an opaque origin may not load a
       * subresource from an `http://` origin on the local network. Chrome
       * enforces this from 150; the request is never sent, so there is no CORS
       * error, no CSP violation and nothing in any log. A linked
       * `<script type="module" src="/assets/…">` therefore never executes, the
       * runner never posts `ready`, and every artifact panel waits forever on a
       * build that cannot start.
       *
       * The same constraint is already handled one layer down: the compiler
       * worker is inlined and constructed from a blob because "a cross-origin
       * worker script is refused outright from an opaque origin". The runner
       * needs the identical treatment for the identical reason — it was simply
       * never hit, because Playwright's bundled Chromium does not enforce the
       * restriction and the end-to-end suite passes against a linked script.
       *
       * Inlining also removes the last network hop between the frame loading and
       * the bridge being live, so `ready` cannot race the application's first
       * `render`.
       */
      enforce: "post",
      apply: "build",
      generateBundle(_options, bundle) {
        const html = Object.values(bundle).find(
          (item) => item.type === "asset" && item.fileName === "index.html",
        );
        if (html?.type !== "asset") return;

        const entry = Object.values(bundle).find(
          (item) => item.type === "chunk" && item.isEntry && item.name === "index",
        );
        if (entry?.type !== "chunk") return;

        const linked = new RegExp(
          `<script[^>]*src="[^"]*${entry.fileName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*></script>`,
        );
        const source = typeof html.source === "string" ? html.source : html.source.toString();
        if (!linked.test(source)) {
          this.warn(`runner chunk ${entry.fileName} is not linked from index.html; not inlined`);
          return;
        }

        const code = entry.code
          /**
           * Vite wraps every dynamic import in its preload helper and passes a
           * `__VITE_PRELOAD__` placeholder it substitutes as it writes the
           * chunk. This chunk is never written — it becomes part of the
           * document — so the placeholder would survive into the browser and
           * throw `__VITE_PRELOAD__ is not defined` the first time a pupil
           * opens a non-static artifact. `inlineDynamicImports` has already put
           * the imported module in this same bundle, so there is nothing left
           * to preload and an empty dependency list is the honest value.
           */
          .replace(/__VITE_PRELOAD__/g, "void 0")
          // `</script>` inside the bundle would close this tag early; nothing
          // else needs escaping, because the content is JavaScript in a module
          // script.
          .replace(/<\/script>/gi, String.raw`<\/script>`);
        html.source = source.replace(linked, `<script type="module">\n${code}\n</script>`);

        // The chunk is now part of the document; leaving it on disk would invite
        // the same unfetchable request back in via a stale reference.
        delete bundle[entry.fileName];
      },
    },
  ],
});
