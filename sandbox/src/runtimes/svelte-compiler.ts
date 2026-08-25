/**
 * The Svelte compiler, for the worker (PRD §13).
 *
 * A separate entry so it is fetched only when a Svelte artifact is opened: it is
 * by far the largest thing this origin serves, and a lesson that only builds
 * HTML and React must never pay for it (§20).
 */
export { compile } from "svelte/compiler";
