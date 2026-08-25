import * as runtime from "react/jsx-runtime";

/**
 * The automatic JSX runtime esbuild emits imports of (§13).
 *
 * `jsxDEV` is the development runtime's entry point; the import map resolves
 * `react/jsx-dev-runtime` here too, so hand-written code that names it works
 * against the production build rather than failing to resolve.
 */
export const { Fragment, jsx, jsxs } = runtime;
export const jsxDEV = runtime.jsx;
