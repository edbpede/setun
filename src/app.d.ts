// See https://svelte.dev/docs/kit/types#app.d.ts
declare global {
  namespace App {
    /**
     * Request-scoped state. Set in `hooks.server.ts`, read in loads, actions and
     * endpoints — server modules never hold mutable state at module scope.
     * Filled in Phase 1 (session, student, classroom).
     */
    interface Locals {}

    /**
     * Errors reaching the browser carry a message and nothing else — no stack
     * traces, no upstream identifiers, no infrastructure detail (PRD §21).
     */
    interface Error {
      message: string;
    }

    interface PageData {}
    interface PageState {}
    interface Platform {}
  }
}

export {};
