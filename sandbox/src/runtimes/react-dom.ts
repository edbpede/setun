import ReactDOM from "react-dom";

/** `react-dom`'s own surface: portals, `flushSync`, and the resource hints (§13). */
export default ReactDOM;

export const {
  createPortal,
  flushSync,
  preconnect,
  prefetchDNS,
  preinit,
  preinitModule,
  preload,
  preloadModule,
  requestFormReset,
  unstable_batchedUpdates,
  useFormStatus,
  version,
} = ReactDOM;
