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
    emptyOutDir: true,
    target: "es2022",
    rollupOptions: {
      // Without this the runtime entries are tree-shaken down to their side
      // effects: nothing in this build imports them, because what imports them
      // is an artifact's import map at runtime.
      preserveEntrySignatures: "strict",
      input: { index: `${root}index.html`, ...runtimeInputs },
      output: {
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
  ],
});
