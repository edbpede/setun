/**
 * The Drizzle schema, one module per aggregate (PRD §19).
 *
 * Re-exported here as the single surface the connection module binds and the
 * query modules import; the migration generator reads it through this file too.
 */
export * from "./classroom";
export * from "./classroom-model-alias";
export * from "./conversation";
export * from "./educator";
export * from "./login-attempt";
export * from "./message";
export * from "./model-alias";
export * from "./session";
export * from "./student";
export * from "./turn";
export * from "./usage-event";
