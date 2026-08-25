/// <reference types="vite/client" />

/**
 * Vite's own module types — `?url` assets and `?worker&inline` constructors —
 * for the sandbox sources. The application's types come from SvelteKit; this
 * origin has its own build, so it needs its own reference (PRD §6).
 */

/**
 * Svelte publishes `svelte/internal/client` without type declarations: it is the
 * compiler's own output target, not an API anyone is meant to call by hand.
 * The sandbox re-exports it verbatim all the same, because that is exactly what
 * a compiled component imports (PRD §13).
 */
declare module "svelte/internal/client";
