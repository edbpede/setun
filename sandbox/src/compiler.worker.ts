import * as esbuild from "esbuild-wasm";
import { SANDBOX_COMPILER_PATH, SVELTE_COMPILER_PATH } from "$lib/artifacts/assets";
import {
  findProjectFile,
  kindOf,
  type ProjectFiles,
  resolveRelative,
} from "$lib/artifacts/project";
import type { CompileRequest, WorkerRequest, WorkerResponse } from "./compile-protocol";

/**
 * The artifact compiler (PRD §13, §20).
 *
 * "TypeScript, JSX, and Svelte compile through `esbuild-wasm` in a worker inside
 * the sandbox origin, against pinned self-hosted ESM runtimes." The worker
 * exists because the target device has two cores and roughly one to spare, so
 * compilation must not be on the thread that is drawing the interface (§20).
 *
 * Everything expensive here is lazy, and stays lazy now that the bytes arrive by
 * message rather than by URL: the WebAssembly binary is requested the first time
 * a non-static artifact is compiled, and the Svelte compiler the first time a
 * `.svelte` file is loaded, so a React-only lesson never pays for it.
 *
 * An artifact is a project of files, so this bundles rather than transforms. The
 * project has no filesystem behind it — every module lives in an esbuild
 * namespace and `projectPlugin` is the whole of the resolution.
 *
 * Nothing here fetches. This worker was built from a blob and inherits the
 * runner's opaque origin, which is the origin that may not read the sandbox
 * host — the same restriction that had the runner inlined into `index.html`.
 * `assets.ts` has the whole account; here it is enough that `request` goes up
 * to the runner and the runner goes up to the application.
 */

/** Assets asked for and not yet answered, by path. */
const waiting = new Map<string, (result: AssetResult) => void>();

type AssetResult = { ok: true; bytes: ArrayBuffer } | { ok: false; message: string };

function request(path: string): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    waiting.set(path, (result) => {
      if (result.ok) resolve(result.bytes);
      else reject(new Error(result.message || `The compiler could not load ${path}.`));
    });
    self.postMessage({ kind: "need-asset", path } satisfies WorkerResponse);
  });
}

async function requestText(path: string): Promise<string> {
  return new TextDecoder().decode(await request(path));
}

let esbuildReady: Promise<void> | null = null;

function initialiseEsbuild(): Promise<void> {
  esbuildReady ??= request(SANDBOX_COMPILER_PATH)
    // Compiled here rather than in the application: `wasm-unsafe-eval` is in this
    // origin's policy, and a WebAssembly.Module is what `initialize` wants when
    // there is no URL to give it.
    .then((bytes) => WebAssembly.compile(bytes))
    .then((wasmModule) =>
      esbuild.initialize({
        wasmModule,
        // We are already the worker; esbuild must not spawn a second one.
        worker: false,
      }),
    )
    .catch((cause: unknown) => {
      // A failed initialisation must not be cached as a settled promise, or every
      // later artifact in the session fails with the first one's message.
      esbuildReady = null;
      throw cause;
    });

  return esbuildReady;
}

/** The Svelte compiler, served from this origin and loaded on first use only. */
type SvelteCompiler = {
  compile: (
    source: string,
    options: Record<string, unknown>,
  ) => { js: { code: string }; warnings?: unknown[] };
};

let svelteReady: Promise<SvelteCompiler> | null = null;

function loadSvelteCompiler(): Promise<SvelteCompiler> {
  svelteReady ??= requestText(SVELTE_COMPILER_PATH)
    // A blob URL is same-origin with this worker by definition, so importing one
    // is the one module load an opaque origin can always make.
    .then((source) => URL.createObjectURL(new Blob([source], { type: "text/javascript" })))
    .then((url) => import(/* @vite-ignore */ url) as Promise<SvelteCompiler>)
    .catch((cause: unknown) => {
      svelteReady = null;
      throw cause;
    });

  return svelteReady;
}

const SCRIPT_BLOCK = /<script([^>]*)>([\s\S]*?)<\/script>/gi;

/**
 * Strip TypeScript out of a Svelte component's script blocks.
 *
 * The Svelte compiler takes JavaScript; models write `<script lang="ts">`
 * habitually, and a component that fails to compile over an annotation is a
 * lesson interrupted for no reason.
 *
 * `verbatimModuleSyntax` matters: without it esbuild removes imports it believes
 * unused, and every component import in a Svelte file is used only by the
 * template, which esbuild cannot see.
 */
async function stripTypeScript(source: string): Promise<string> {
  const blocks = [...source.matchAll(SCRIPT_BLOCK)].filter(([, attributes]) =>
    /lang\s*=\s*["']?(ts|typescript)["']?/i.test(attributes),
  );

  if (blocks.length === 0) return source;

  let result = source;
  for (const [whole, attributes, body] of blocks) {
    const transformed = await esbuild.transform(body, {
      loader: "ts",
      format: "esm",
      target: "es2022",
      tsconfigRaw: { compilerOptions: { verbatimModuleSyntax: true } },
    });

    const cleaned = attributes.replace(/\s*lang\s*=\s*["']?(ts|typescript)["']?/i, "");
    result = result.replace(whole, `<script${cleaned}>\n${transformed.code}</script>`);
  }

  return result;
}

/**
 * The bare names an artifact may import (PRD §13).
 *
 * The pinned self-hosted runtimes and nothing else: there is no network in the
 * frame, so anything else would fail at run time with a message about a module
 * specifier rather than at build time with one a pupil can act on.
 */
const RUNTIME_MODULES = [
  "react",
  "react/jsx-runtime",
  "react/jsx-dev-runtime",
  "react-dom",
  "react-dom/client",
  "svelte",
  "svelte/internal/client",
  "svelte/internal/disclose-version",
  "svelte/internal/flags/legacy",
  "svelte/internal/flags/async",
];

function isRuntimeModule(specifier: string): boolean {
  return RUNTIME_MODULES.includes(specifier);
}

/** The esbuild loader for a project file, by extension. */
const LOADERS: Readonly<Record<string, esbuild.Loader>> = {
  tsx: "tsx",
  ts: "ts",
  jsx: "jsx",
  js: "js",
  css: "css",
  json: "json",
  html: "text",
  svg: "text",
  md: "text",
};

/** A component's name, which Svelte uses in its own error messages. */
function componentName(path: string): string {
  const base = path.split("/").pop() ?? "Artifact";
  const stem = base.replace(/\.svelte$/i, "").replace(/[^A-Za-z0-9_$]/g, "_");
  return /^[A-Za-z_$]/.test(stem) ? stem : `A${stem}`;
}

/**
 * The project as a virtual filesystem esbuild can resolve against (§13).
 *
 * There is no filesystem here at all: every module lives in the `project`
 * namespace, and the plugin is the whole of the resolution. Two of its rules are
 * the pupil-facing ones — an import outside the allowed runtimes, and a relative
 * import naming nothing — and both answer with the message a pupil reads.
 */
function projectPlugin(files: ProjectFiles): esbuild.Plugin {
  const known = Object.keys(files).sort();

  return {
    name: "project",
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        if (args.kind === "entry-point") return { path: args.path, namespace: "project" };

        if (!args.path.startsWith(".")) {
          if (isRuntimeModule(args.path)) return { path: args.path, external: true };

          return {
            errors: [
              {
                text: `Cannot import "${args.path}". An artifact may import its own files by relative path, plus ${RUNTIME_MODULES.join(", ")}.`,
              },
            ],
          };
        }

        const resolved = resolveRelative(args.importer, args.path);
        const found = resolved ? findProjectFile(files, resolved) : null;

        if (!found) {
          return {
            errors: [
              {
                text: `Cannot find "${args.path}" from ${args.importer}. This project holds ${known.join(", ")}.`,
              },
            ],
          };
        }

        return { path: found, namespace: "project" };
      });

      build.onLoad({ filter: /.*/, namespace: "project" }, async (args) => {
        const contents = files[args.path];
        if (contents === undefined) {
          return { errors: [{ text: `Cannot find ${args.path} in this project.` }] };
        }

        if (args.path.toLowerCase().endsWith(".svelte")) {
          const { compile: compileSvelte } = await loadSvelteCompiler();
          // No `runes` option: Svelte decides from the source itself, so a
          // component written in either dialect compiles rather than one of them
          // failing. `css: "injected"` puts a component's own styles in its
          // module, which is where a component's styles belong.
          const output = compileSvelte(await stripTypeScript(contents), {
            generate: "client",
            name: componentName(args.path),
            filename: args.path,
            css: "injected",
          });

          return { contents: output.js.code, loader: "js" };
        }

        return { contents, loader: LOADERS[kindOf(args.path) ?? ""] ?? "text" };
      });
    },
  };
}

async function compile(job: CompileRequest): Promise<{ code: string; css: string }> {
  await initialiseEsbuild();

  const result = await esbuild.build({
    entryPoints: [job.entry],
    bundle: true,
    format: "esm",
    target: "es2022",
    // Mandatory in the browser: there is nowhere to write to, and the outputs
    // are what the runner puts in the document.
    write: false,
    outdir: "/out",
    // The automatic runtime means the model need not import React by hand,
    // which is how current React code is written and therefore what models emit.
    jsx: "automatic",
    jsxImportSource: "react",
    plugins: [projectPlugin(job.files)],
    // Neither is worth the milliseconds on a two-core Chromebook: nobody reads
    // the bundle, and the compiler's own message is what a pupil debugs from.
    sourcemap: false,
    legalComments: "none",
  });

  const outputs = result.outputFiles ?? [];
  const code = outputs
    .filter((file) => file.path.endsWith(".js"))
    .map((file) => file.text)
    .join("\n");
  const css = outputs
    .filter((file) => file.path.endsWith(".css"))
    .map((file) => file.text)
    .join("\n");

  return { code, css };
}

function describe(cause: unknown): string {
  if (cause && typeof cause === "object" && "errors" in cause) {
    const errors = (
      cause as {
        errors?: { text?: string; location?: { line?: number; file?: string } }[];
      }
    ).errors;
    const first = errors?.[0];

    if (first?.text) {
      // A project has several files, so an error that names only a line names
      // half of where it is. The `Line N:` token stays, because the panel reads
      // it to put the pupil's cursor there.
      const file = first.location?.file?.replace(/^project:/, "");
      const line = first.location?.line ? `Line ${first.location.line}: ` : "";
      const where = file && line ? `${file} — ` : file ? `${file}: ` : "";

      return `${where}${line}${first.text}`;
    }
  }

  return cause instanceof Error ? cause.message : String(cause);
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const message = event.data;

  if (message.kind === "asset") {
    const settle = waiting.get(message.path);
    waiting.delete(message.path);
    settle?.(
      message.ok ? { ok: true, bytes: message.bytes } : { ok: false, message: message.message },
    );
    return;
  }

  try {
    const { code, css } = await compile(message);
    self.postMessage({
      kind: "compiled",
      id: message.id,
      ok: true,
      code,
      css,
    } satisfies WorkerResponse);
  } catch (cause) {
    self.postMessage({
      kind: "compiled",
      id: message.id,
      ok: false,
      message: describe(cause),
    } satisfies WorkerResponse);
  }
};
