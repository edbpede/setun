/**
 * Keeping a static-file problem from becoming an outage (PRD §5, §21).
 *
 * Two helpers, both used by `server.js` and both about the same failure: the
 * set of files adapter-node believes it can serve and the set actually on disk
 * are allowed to disagree. `installServerGuard` keeps that from ending the
 * process; `dropMissingEncodings` keeps it from stalling the request.
 *
 * They live here rather than in `server.js` so a test can exercise them without
 * starting a server.
 *
 * ---
 *
 * Keeping the server alive when a single file read fails.
 *
 * `bun ./build/index.js` is adapter-node's own entry point, and adapter-node
 * serves `build/client` with a static handler that reads pre-compressed
 * variants (`.br`, `.gz`) directly from disk. That handler decides which
 * variants exist once, at startup. If one of those files is not there when the
 * read actually happens, the resulting `ENOENT` reaches nothing that handles it,
 * and the process exits.
 *
 * A single unauthenticated `GET` for one asset then ends the lesson for every
 * pupil in the school, and nothing serves again until an operator restarts. That
 * is not a hypothetical: the set of files on disk and the set the handler
 * believes in diverge whenever a deployment writes into `build/` under a running
 * server, whenever a copy lands `.js` before its `.br`, and whenever a build is
 * interrupted.
 *
 * Whatever the cause, the response is the same: the request that touched the
 * missing file should fail, and only that request. So this module installs the
 * handler adapter-node does not, narrowly:
 *
 *   - a filesystem error about a specific path is logged and swallowed;
 *   - everything else keeps the old behaviour and exits, because an unexpected
 *     fault may well have left the process in a state where continuing is worse
 *     than restarting.
 *
 * `server.js` installs this and then hands straight over to adapter-node's own
 * entry point, rather than wrapping `build/handler.js` in a server of our own: a
 * wrapper would have to restate adapter-node's socket activation, keep-alive
 * tuning and graceful shutdown, and would silently fall behind the adapter on
 * the next upgrade. This adds two listeners and touches nothing else.
 *
 * Nothing here logs a URL, a body or a header — only the syscall, the error
 * code and the path, which is the same class of detail §16 already permits.
 */

import { existsSync } from "node:fs";
import { join, normalize } from "node:path";

/**
 * Error codes that mean "this one file could not be read", and nothing worse.
 *
 * Deliberately not a catch-all. `EMFILE` and `ENOMEM` are also `fs` errors and
 * are deliberately absent: they say the process is out of a resource, which is
 * exactly the case where exiting and being restarted is the right answer.
 */
const RECOVERABLE_FS_CODES = new Set(["ENOENT", "EACCES", "EPERM", "EISDIR", "ENOTDIR", "ELOOP"]);

/**
 * True for an error that is a failed read of one named file.
 *
 * Both `syscall` and `path` are required. A bare `ENOENT` with neither is not a
 * file read — it is something rethrowing a code it liked the look of, and it
 * gets the default treatment.
 */
export function isRecoverableFileError(error) {
  if (typeof error !== "object" || error === null) return false;

  const candidate = /** @type {NodeJS.ErrnoException} */ (error);

  return (
    typeof candidate.code === "string" &&
    RECOVERABLE_FS_CODES.has(candidate.code) &&
    typeof candidate.syscall === "string" &&
    typeof candidate.path === "string"
  );
}

/**
 * One line an operator can act on, carrying no request detail.
 *
 * The path is the asset that is missing, which is the whole point of the line;
 * it is a build artefact path, not anything a pupil wrote.
 */
function describe(error) {
  const { code, syscall, path } = /** @type {NodeJS.ErrnoException} */ (error);
  return `${code} on ${syscall}: ${path}`;
}

/**
 * Install the listeners.
 *
 * Exported so a test can drive it against a stub process rather than the real
 * one — registering a real `uncaughtException` handler inside a test runner
 * would change how that runner reports every later failure.
 */
export function installServerGuard(target = process) {
  target.on("uncaughtException", (error) => {
    if (isRecoverableFileError(error)) {
      console.error(`server-guard: recovered from a failed file read — ${describe(error)}`);
      return;
    }

    console.error(error);
    target.exit(1);
  });

  target.on("unhandledRejection", (reason) => {
    if (isRecoverableFileError(reason)) {
      console.error(`server-guard: recovered from a failed file read — ${describe(reason)}`);
      return;
    }

    console.error(reason);
    target.exit(1);
  });
}

/**
 * Pre-compressed encodings adapter-node serves from disk, and the suffix each
 * one is stored under.
 */
const ENCODINGS = [
  ["br", ".br"],
  ["gzip", ".gz"],
];

/**
 * Ask for a pre-compressed variant only if it is actually on disk.
 *
 * adapter-node's static handler works out which `.br` and `.gz` files exist
 * once, when the server starts. Disk can disagree with that list afterwards — a
 * deployment writing into `build/` under a running server, a copy that lands
 * `.js` before its `.br`, an interrupted build — and the handler then opens a
 * file that is not there. `server-guard.js` keeps that from ending the process,
 * but the request itself is already half-served and simply stops, so the browser
 * waits for a chunk that never arrives and the page stays broken.
 *
 * Checking here costs one `existsSync` on requests that both ask for a
 * compressed encoding and address a build asset, and turns that case into an
 * ordinary uncompressed response. The pupil gets their page.
 *
 * Only `/_app/` is considered: those are the hashed, immutable build outputs,
 * the only files adapter-node pre-compresses, and the only place this can
 * happen. Anything else is passed through untouched.
 */
export function dropMissingEncodings(req, clientDir) {
  const accept = req.headers["accept-encoding"];
  if (typeof accept !== "string" || accept === "") return;

  const pathname = (req.url ?? "").split("?")[0];
  if (!pathname.startsWith("/_app/")) return;

  let asset;
  try {
    // `normalize` collapses any `..` before the prefix check below, so a crafted
    // path cannot make this stat a file outside the build directory.
    //
    // Wrapped, because both steps throw on input a client is free to send:
    // `decodeURIComponent` on a malformed escape such as `/_app/%`, and `join`
    // on a path containing a null byte. This runs inside a `request` listener,
    // where an exception would reach nothing — and the process guard is
    // deliberately narrow enough not to catch it. A request we cannot make sense
    // of is simply left alone for the static handler to reject as it always has.
    asset = normalize(join(clientDir, decodeURIComponent(pathname)));
  } catch {
    return;
  }

  if (!asset.startsWith(clientDir)) return;

  // Match the way adapter-node's static handler reads this header, or the two
  // disagree and the request reaches the missing file anyway. That handler tests
  // the whole header value for a case-insensitive substring — `/(br|brotli)/i`
  // for Brotli, `.includes("gzip")` for gzip — so `BR` and `x-gzip` both select a
  // pre-compressed variant there.
  //
  // Hence: lower case on both sides, and substring rather than prefix. Dropping a
  // part is only useful if no occurrence of the token survives anywhere in what
  // is left, which is exactly what the handler will look at.
  const normalized = accept.toLowerCase();

  const missing = ENCODINGS.filter(
    ([token, suffix]) => normalized.includes(token) && !existsSync(asset + suffix),
  ).map(([token]) => token);

  if (missing.length === 0) return;

  const kept = accept
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "" && !missing.some((token) => part.toLowerCase().includes(token)));

  // An empty header would be rejected outright, so fall back to the encoding
  // every client understands rather than leaving nothing behind.
  req.headers["accept-encoding"] = kept.length > 0 ? kept.join(", ") : "identity";
}
