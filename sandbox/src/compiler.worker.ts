import * as esbuild from "esbuild-wasm";
import wasmUrl from "esbuild-wasm/esbuild.wasm?url";
import type { CompileRequest, CompileResponse } from "./compile-protocol";

/**
 * The artifact compiler (PRD §13, §20).
 *
 * "TypeScript, JSX, and Svelte compile through `esbuild-wasm` in a worker inside
 * the sandbox origin, against pinned self-hosted ESM runtimes." The worker
 * exists because the target device has two cores and roughly one to spare, so
 * compilation must not be on the thread that is drawing the interface (§20).
 *
 * Everything expensive here is lazy: the WebAssembly binary is fetched the first
 * time a non-static artifact is compiled and cached by the browser thereafter,
 * and the Svelte compiler is a dynamic import that a React-only lesson never
 * pays for.
 */

let esbuildReady: Promise<void> | null = null;

function initialiseEsbuild(origin: string): Promise<void> {
  esbuildReady ??= esbuild.initialize({
    // Absolute: a blob-URL worker has no path of its own to resolve against.
    wasmURL: new URL(wasmUrl, origin).href,
    // We are already the worker; esbuild must not spawn a second one.
    worker: false,
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

function loadSvelteCompiler(origin: string): Promise<SvelteCompiler> {
  svelteReady ??= import(
    /* @vite-ignore */ `${origin}/runtimes/svelte-compiler.js`
  ) as Promise<SvelteCompiler>;

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

async function compile(request: CompileRequest): Promise<string> {
  await initialiseEsbuild(request.origin);

  if (request.language === "svelte") {
    const { compile: compileSvelte } = await loadSvelteCompiler(request.origin);
    // No `runes` option: Svelte decides from the source itself, so a component
    // written in either dialect compiles rather than one of them failing.
    const output = compileSvelte(await stripTypeScript(request.source), {
      generate: "client",
      name: "Artifact",
    });

    return output.js.code;
  }

  const output = await esbuild.transform(request.source, {
    loader: request.language,
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

self.onmessage = async (event: MessageEvent<CompileRequest>) => {
  const request = event.data;

  try {
    const code = await compile(request);
    self.postMessage({ id: request.id, ok: true, code } satisfies CompileResponse);
  } catch (cause) {
    self.postMessage({
      id: request.id,
      ok: false,
      message: describe(cause),
    } satisfies CompileResponse);
  }
};
