/**
 * The production entry point (PRD §5).
 *
 * `bun ./server.js` does two small things and then gets out of the way:
 *
 *   1. installs the process guard, so a failed read of one file fails that
 *      request instead of the whole server;
 *   2. drops a stale `Accept-Encoding` before adapter-node's static handler
 *      sees it, so that request succeeds rather than hanging.
 *
 * adapter-node's generated entry still owns the socket, the timeouts and the
 * graceful shutdown, exactly as before. `build/index.js` is generated, so it is
 * imported rather than edited — a patch applied there would last until the next
 * `bun run build`.
 *
 * Both helpers live in `server-guard.js` so they can be tested without starting
 * a server; this file is only the wiring.
 */

import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { dropMissingEncodings, installServerGuard } from "./server-guard.js";

// Before the import below, so the listeners exist before the adapter starts
// accepting connections and the first request cannot outrun them.
installServerGuard();

/**
 * Which adapter-node output to run.
 *
 * `build/`, beside this file, in every ordinary case — the Dockerfile copies it
 * there and `bun run build` writes it there. SETUN_BUILD_DIR is the dev suite's
 * override, matching `out` in svelte.config.js, so two of its instances can each
 * run their own build instead of taking turns emptying one directory.
 *
 * Resolved against this file rather than the working directory, so `bun
 * ./server.js` means the same thing from anywhere; an absolute value wins
 * outright, which is what the suite passes.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const BUILD_DIR = resolve(HERE, process.env.SETUN_BUILD_DIR || "build");

// A file URL rather than the path: a dynamic `import()` of an absolute POSIX
// path is not portable, and this one is absolute by construction.
const { server } = await import(pathToFileURL(join(BUILD_DIR, "index.js")).href);

const CLIENT_DIR = join(BUILD_DIR, "client");

// Prepended rather than added: adapter-node has its own `request` listener for
// the in-flight request count, and polka's handler runs from another. Both must
// keep running, and both must see the corrected header.
server.server.prependListener("request", (req) => dropMissingEncodings(req, CLIENT_DIR));
