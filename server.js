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

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { dropMissingEncodings, installServerGuard } from "./server-guard.js";

// Before the import below, so the listeners exist before the adapter starts
// accepting connections and the first request cannot outrun them.
installServerGuard();

const { server } = await import("./build/index.js");

const CLIENT_DIR = join(dirname(fileURLToPath(import.meta.url)), "build", "client");

// Prepended rather than added: adapter-node has its own `request` listener for
// the in-flight request count, and polka's handler runs from another. Both must
// keep running, and both must see the corrected header.
server.server.prependListener("request", (req) => dropMissingEncodings(req, CLIENT_DIR));
