/**
 * The files the sandbox origin serves, fetched for it rather than by it (§13, §14).
 *
 * Nothing inside the sandbox fetches anything. Every document there has an
 * opaque origin, and an opaque origin is the worst position in the browser from
 * which to ask for a subresource: it is not a secure context, so it can hold no
 * permission a network restriction might gate on, and it sends `Origin: null`,
 * which a server has to opt into by name. Chrome already tightened this once —
 * a linked module script stopped loading from an opaque origin, and the runner
 * had to be inlined into `index.html` — and the compiler's WebAssembly and the
 * pinned runtimes were the same arrangement one layer down.
 *
 * So the application fetches them. It is an ordinary origin, the same GET is
 * unremarkable there, and `Access-Control-Allow-Origin: *` on the sandbox host
 * already permits it. What crosses into the sandbox afterwards is bytes on a
 * channel that already exists, which no network policy has an opinion about.
 *
 * ## Why paths, and what bounds them
 *
 * The sandbox asks by path, because the runtimes are a code-split graph whose
 * shared chunks carry build hashes in their names — `assets/react-CwJFpaho.js`
 * cannot be written down here, and the build's own manifest is the only thing
 * that knows it. A path is therefore not a fixed identifier, and the bound has
 * to come from a shape rather than a list: `isSandboxAssetPath` accepts only a
 * plain filename under `runtimes/` or `assets/`, so the application can be asked
 * to read one of two directories on the sandbox origin and nothing else — no
 * traversal, no other host, no other scheme.
 */

/**
 * The files whose names are fixed, because something has to be.
 *
 * The manifest is how everything else is found, and the two compilers are named
 * outright because neither is part of the graph the manifest describes: the
 * WebAssembly is not a module at all, and the Svelte compiler is built as one
 * self-contained file precisely so that it needs no graph.
 */
export const SANDBOX_MANIFEST_PATH = "runtimes/manifest.json";
export const SANDBOX_COMPILER_PATH = "assets/esbuild.wasm";

/**
 * A path the application will read on the sandbox origin.
 *
 * Deliberately narrow: one of two directory names, then a single path segment
 * of ordinary filename characters, then a known extension. `..` cannot appear
 * because `.` is allowed but `/` is not, so there is no second segment at all.
 */
const SAFE_PATH = /^(?:runtimes|assets)\/[A-Za-z0-9][A-Za-z0-9._-]*\.(?:js|json|wasm)$/;

export function isSandboxAssetPath(value: unknown): value is string {
  return typeof value === "string" && SAFE_PATH.test(value) && !value.includes("..");
}

export function sandboxAssetUrl(origin: string, path: string): string {
  return `${origin}/${path}`;
}

/**
 * What the sandbox build publishes about its own output (`runtimes/manifest.json`).
 *
 * The pinned runtimes are one code-split module graph — `react-dom/client` and
 * `react` share React itself, and duplicating it would give an artifact two
 * Reacts and no working hooks — so the files reference each other. The build
 * rewrites those references from relative paths, which cannot resolve from a
 * blob URL, to `setun:` specifiers, and records here what each entry needs.
 */
export interface RuntimeManifest {
  /** Bare specifier an artifact may import → the entry that satisfies it. */
  readonly specifiers: Readonly<Record<string, string>>;
  /** Entry name → its own file and the chunk specifiers it transitively needs. */
  readonly entries: Readonly<
    Record<string, { readonly file: string; readonly needs: readonly string[] }>
  >;
  /** `setun:` chunk specifier → the file that satisfies it. */
  readonly chunks: Readonly<Record<string, string>>;
}

/** Entry names, as the build knows them. Used to pick a framework's set. */
export const FRAMEWORK_ENTRIES: Readonly<Record<"react" | "svelte", readonly string[]>> = {
  react: ["react", "react-dom", "react-dom-client", "react-jsx-runtime"],
  svelte: [
    "svelte",
    "svelte-internal-client",
    "svelte-disclose-version",
    "svelte-flags-legacy",
    "svelte-flags-async",
  ],
};

/** The utility CSS runtime, imported for its effect rather than its exports. */
export const UNOCSS_ENTRY = "unocss";

/**
 * The Svelte compiler, which the worker loads and no artifact ever names.
 *
 * A fixed path rather than a manifest entry, because the worker cannot use one:
 * a worker has no import map, so the compiler is built in a pass of its own as a
 * single self-contained file with no sibling chunk to resolve. See the
 * `COMPILER` note in `sandbox/vite.config.ts`.
 */
export const SVELTE_COMPILER_PATH = "runtimes/svelte-compiler.js";

export function isRuntimeManifest(value: unknown): value is RuntimeManifest {
  if (typeof value !== "object" || value === null) return false;

  const record = value as Record<string, unknown>;
  const table = (held: unknown): boolean =>
    typeof held === "object" && held !== null && !Array.isArray(held);

  return table(record.specifiers) && table(record.entries) && table(record.chunks);
}
