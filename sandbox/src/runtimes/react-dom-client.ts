import ReactDOMClient from "react-dom/client";

/** `createRoot`, which the mount harness uses (§13). */
export default ReactDOMClient;

export const { createRoot, hydrateRoot } = ReactDOMClient;
