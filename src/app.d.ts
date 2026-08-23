// See https://svelte.dev/docs/kit/types#app.d.ts
declare global {
  namespace App {
    /**
     * Request-scoped state. Set in `hooks.server.ts`, read in loads, actions and
     * endpoints — server modules never hold mutable state at module scope.
     */
    interface Locals {
      /** The authenticated student, or null. Resolved from the session cookie (PRD §7). */
      student: import("$lib/server/db/schema").Student | null;
      /** The presented session token, kept so logout can invalidate exactly this session. */
      sessionToken: string | null;
    }

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
