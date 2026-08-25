/**
 * The runner's protocol with its compiler worker (PRD §13).
 *
 * Both ends live on the sandbox origin, so this is an internal arrangement — the
 * application never sees these messages, and the artifact never sees them at all.
 */

export type CompiledLanguage = "jsx" | "tsx" | "svelte";

export interface CompileRequest {
  readonly id: string;
  /**
   * The sandbox origin, resolved by the runner from its own location.
   *
   * The worker runs from a blob URL — a cross-origin worker script is refused
   * outright from an opaque origin — and a blob URL carries no path to resolve
   * root-relative asset URLs against, so the base has to be handed to it.
   */
  readonly origin: string;
  readonly language: CompiledLanguage;
  readonly source: string;
}

export type CompileResponse =
  | { readonly id: string; readonly ok: true; readonly code: string }
  /** The compiler's own message: this is what a pupil debugging their code reads. */
  | { readonly id: string; readonly ok: false; readonly message: string };
