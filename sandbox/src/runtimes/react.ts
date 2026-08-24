import React from "react";

/**
 * Pinned, self-hosted React (PRD §13).
 *
 * "Against pinned self-hosted ESM runtimes — React and Svelte, the two
 * frameworks models most reliably emit; no other frameworks are hosted." The
 * version is whatever the repository's lockfile pins, built here into an ES
 * module the artifact's import map resolves to. No public CDN is contacted.
 *
 * The surface is enumerated rather than re-exported with `export *`: React
 * publishes CommonJS, whose named exports a bundler cannot see statically, and
 * a star re-export of it silently produces a module with no exports at all.
 */
export default React;

export const {
  Children,
  Component,
  Fragment,
  Profiler,
  PureComponent,
  StrictMode,
  Suspense,
  cache,
  cloneElement,
  createContext,
  createElement,
  createRef,
  forwardRef,
  isValidElement,
  lazy,
  memo,
  startTransition,
  use,
  useActionState,
  useCallback,
  useContext,
  useDebugValue,
  useDeferredValue,
  useEffect,
  useId,
  useImperativeHandle,
  useInsertionEffect,
  useLayoutEffect,
  useMemo,
  useOptimistic,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
  version,
} = React;
