/**
 * The runner's protocol with its compiler worker (PRD §13).
 *
 * Both ends live on the sandbox origin, so this is an internal arrangement — the
 * application never sees these messages, and the artifact never sees them at all.
 *
 * The worker asks the runner for the files it needs, and the runner asks the
 * application, for one reason at both hops: the worker runs from a blob URL and
 * inherits the runner's opaque origin, which is the origin that may not fetch
 * from the sandbox host. See `src/lib/artifacts/assets.ts`.
 */

export type CompiledLanguage = "jsx" | "tsx" | "svelte";

export interface CompileRequest {
  readonly id: string;
  readonly language: CompiledLanguage;
  readonly source: string;
}

/** Runner → worker. */
export type WorkerRequest =
  | ({ readonly kind: "compile" } & CompileRequest)
  | {
      readonly kind: "asset";
      readonly path: string;
      readonly ok: true;
      readonly bytes: ArrayBuffer;
    }
  | {
      readonly kind: "asset";
      readonly path: string;
      readonly ok: false;
      readonly message: string;
    };

export type CompileResponse =
  | { readonly id: string; readonly ok: true; readonly code: string }
  /** The compiler's own message: this is what a pupil debugging their code reads. */
  | { readonly id: string; readonly ok: false; readonly message: string };

/** Worker → runner. */
export type WorkerResponse =
  | ({ readonly kind: "compiled" } & CompileResponse)
  | { readonly kind: "need-asset"; readonly path: string };
