import * as esbuild from "esbuild-wasm";
import { SANDBOX_COMPILER_PATH, SVELTE_COMPILER_PATH } from "$lib/artifacts/assets";
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
 * `.svelte` one is, so a React-only lesson never pays for it.
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

async function compile(job: CompileRequest): Promise<string> {
  await initialiseEsbuild();

  if (job.language === "svelte") {
    const { compile: compileSvelte } = await loadSvelteCompiler();
    // No `runes` option: Svelte decides from the source itself, so a component
    // written in either dialect compiles rather than one of them failing.
    const output = compileSvelte(await stripTypeScript(job.source), {
      generate: "client",
      name: "Artifact",
    });

    return output.js.code;
  }

  const output = await esbuild.transform(job.source, {
    loader: job.language,
    format: "esm",
    target: "es2022",
    // The automatic runtime means the model need not import React by hand,
    // which is how current React code is written and therefore what models emit.
    jsx: "automatic",
    jsxImportSource: "react",
  });

  return output.code;
}

function describe(cause: unknown): string {
  if (cause && typeof cause === "object" && "errors" in cause) {
    const errors = (cause as { errors?: { text?: string; location?: { line?: number } }[] }).errors;
    const first = errors?.[0];
    if (first?.text) {
      return first.location?.line ? `Line ${first.location.line}: ${first.text}` : first.text;
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
    const code = await compile(message);
    self.postMessage({ kind: "compiled", id: message.id, ok: true, code } satisfies WorkerResponse);
  } catch (cause) {
    self.postMessage({
      kind: "compiled",
      id: message.id,
      ok: false,
      message: describe(cause),
    } satisfies WorkerResponse);
  }
};
